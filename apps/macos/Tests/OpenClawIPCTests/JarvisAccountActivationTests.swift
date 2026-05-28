import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct JarvisAccountActivationTests {
    @Test func `activation client posts login request and decodes account summary`() async throws {
        let client = JarvisAccountActivationClient(
            configuration: .init(
                baseURL: try #require(URL(string: "https://jarvis.example.test")),
                backendAccessToken: "backend-token"),
            transport: { request in
                #expect(request.url?.path == "/v1/account/login")
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer backend-token")

                let bodyData = try #require(request.httpBody)
                let body = try #require(
                    JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
                #expect(body["email"] as? String == "user@example.com")
                #expect(body["deviceId"] as? String == "device-1")
                #expect(body["platform"] as? String == "macos")

                let response = """
                {
                  "accountId": "acct_123",
                  "email": "user@example.com",
                  "accountAccessToken": "jat_secret",
                  "license": { "plan": "beta" }
                }
                """
                return try Self.httpResponse(
                    url: #require(request.url),
                    statusCode: 200,
                    body: response)
            })

        let response = try await client.login(email: " User@Example.com ", deviceId: "device-1")

        #expect(response.accountId == "acct_123")
        #expect(response.email == "user@example.com")
        #expect(response.accountAccessToken == "jat_secret")
        #expect(response.licenseSummary == "beta")
    }

    @Test func `activation client maps inactive email to recovery error without token logging`() async throws {
        let client = JarvisAccountActivationClient(
            configuration: .init(
                baseURL: try #require(URL(string: "https://jarvis.example.test")),
                backendAccessToken: "backend-token"),
            transport: { request in
                try Self.httpResponse(
                    url: #require(request.url),
                    statusCode: 403,
                    body: #"{"detail":"Invite expired."}"#)
            })

        await #expect(throws: JarvisAccountActivationError.invalidOrExpired("Invite expired.")) {
            _ = try await client.login(email: "user@example.com", deviceId: "device-1")
        }
    }

    @Test func `activation client uses public account recovery copy when backend omits detail`() async throws {
        let client = JarvisAccountActivationClient(
            configuration: .init(
                baseURL: try #require(URL(string: "https://jarvis.example.test")),
                backendAccessToken: "backend-token"),
            transport: { request in
                try Self.httpResponse(
                    url: #require(request.url),
                    statusCode: 403,
                    body: #"{}"#)
            })

        await #expect(throws: JarvisAccountActivationError.invalidOrExpired(JarvisAccountActivationCopy.inactiveEmail)) {
            _ = try await client.login(email: "user@example.com", deviceId: "device-1")
        }
    }

    @Test func `activation client hides future otp recovery internals for existing email conflict`() async throws {
        let client = JarvisAccountActivationClient(
            configuration: .init(
                baseURL: try #require(URL(string: "https://jarvis.example.test")),
                backendAccessToken: "backend-token"),
            transport: { request in
                try Self.httpResponse(
                    url: #require(request.url),
                    statusCode: 409,
                    body: #"{"detail":"Account recovery requires a future OTP or magic-code flow."}"#)
            })

        await #expect(throws: JarvisAccountActivationError.rejected(JarvisAccountActivationCopy.accountRecoveryUnavailable)) {
            _ = try await client.login(email: "user@example.com", deviceId: "device-1")
        }
    }

    @Test func `activation model stores token in file bridge and writes file token ref to config`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-account-token-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let tokenStore = JarvisAccountActivationFileStore()
            let tokenFileURL = JarvisAccountActivationFileStore.defaultTokenFileURL()
            let savedRoot = SavedActivationRoot()
            let model = JarvisAccountActivationModel(
                email: "user@example.com",
                tokenStore: tokenStore,
                loadConfig: {
                    [
                        "jarvis": [
                            "backend": [
                                "baseUrl": "https://jarvis.example.test",
                                "accessToken": "backend-token",
                            ],
                        ],
                    ]
                },
                saveConfig: { root in savedRoot.set(root) },
                makeClient: { _ in
                    JarvisAccountActivationClient(
                        configuration: .init(
                            baseURL: try #require(URL(string: "https://jarvis.example.test")),
                            backendAccessToken: "backend-token"),
                        transport: { request in
                            try Self.httpResponse(
                                url: #require(request.url),
                                statusCode: 200,
                                body: """
                                {
                                  "accountId": "acct_123",
                                  "email": "user@example.com",
                                  "accountAccessToken": "jat_secret",
                                  "license": "beta"
                                }
                                """)
                        })
                })

            await model.activate()

            #expect(tokenStore.loadAccountAccessToken()?.isEmpty == false)
            #expect(model.isActivated)

            let backend = try #require((savedRoot.value()["jarvis"] as? [String: Any])?["backend"] as? [String: Any])
            let account = try #require(backend["account"] as? [String: Any])
            #expect(account["accountId"] as? String == "acct_123")
            #expect(account["email"] as? String == "user@example.com")
            #expect(account["license"] as? String == "beta")
            #expect(backend["accountAccessToken"] as? [String: String] == [
                "source": "file",
                "provider": "jarvis-account-token",
                "id": "value",
            ])
            let providers = try #require((savedRoot.value()["secrets"] as? [String: Any])?["providers"] as? [String: Any])
            let fileProvider = try #require(providers["jarvis-account-token"] as? [String: Any])
            #expect(fileProvider["source"] as? String == "file")
            #expect(fileProvider["path"] as? String == tokenFileURL.path)
            #expect(fileProvider["mode"] as? String == "singleValue")
            #expect(fileProvider["command"] == nil)

            try Self.expectPermissions(tokenFileURL, maskedBy: 0o777, equal: 0o600)
            try Self.expectNotWorldWritable(tokenFileURL.deletingLastPathComponent())
            try Self.expectNotWorldWritable(stateDir)

            let loadedModel = JarvisAccountActivationModel(
                tokenStore: tokenStore,
                loadConfig: { savedRoot.value() },
                saveConfig: { _ in },
                makeClient: { _ in
                    Issue.record("loadStoredActivation must not create a backend client")
                    throw JarvisAccountActivationError.invalidResponse
                })
            await loadedModel.loadStoredActivation()

            #expect(loadedModel.isActivated)
            #expect(loadedModel.email == "user@example.com")
        }
    }

    @Test func `activation model does not resume account summary without saved token file`() async throws {
        let savedRoot = SavedActivationRoot()
        var root: [String: Any] = [:]
        JarvisAccountActivationConfig.saveSummary(
            .init(accountId: "acct_123", email: "user@example.com", licenseSummary: "beta"),
            into: &root)
        savedRoot.set(root)

        let model = JarvisAccountActivationModel(
            tokenStore: MockAccountTokenStore(),
            loadConfig: { savedRoot.value() },
            saveConfig: { _ in },
            makeClient: { _ in
                Issue.record("loadStoredActivation must not create a backend client")
                throw JarvisAccountActivationError.invalidResponse
            })

        await model.loadStoredActivation()

        #expect(!model.isActivated)
    }

    @Test func `managed bot configuration resolves account token from activation storage`() throws {
        let configuration = try JarvisTelegramManagedBotClient.resolveConfiguration(
            root: [
                "jarvis": [
                    "backend": [
                        "baseUrl": "https://jarvis.example.test",
                        "accessToken": "backend-token",
                    ],
                ],
            ],
            accountTokenStore: MockAccountTokenStore(token: "jat_stored"))

        #expect(configuration.accountAccessToken?.hasPrefix("jat_") == true)
    }

    private nonisolated static func httpResponse(
        url: URL,
        statusCode: Int,
        body: String
    ) throws -> (Data, HTTPURLResponse) {
        let response = try #require(HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: nil))
        return (Data(body.utf8), response)
    }

    private nonisolated static func expectPermissions(
        _ url: URL,
        maskedBy mask: Int,
        equal expected: Int
    ) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let permissions = try #require(attributes[.posixPermissions] as? NSNumber).intValue
        #expect((permissions & mask) == expected)
    }

    private nonisolated static func expectNotWorldWritable(_ url: URL) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let permissions = try #require(attributes[.posixPermissions] as? NSNumber).intValue
        #expect((permissions & 0o002) == 0)
    }
}

private final class MockAccountTokenStore: JarvisAccountAccessTokenStoring, @unchecked Sendable {
    private var token: String?

    init(token: String? = nil) {
        self.token = token
    }

    func loadAccountAccessToken() -> String? {
        self.token
    }

    func saveAccountAccessToken(_ token: String) throws {
        self.token = token
    }
}

private final class SavedActivationRoot: @unchecked Sendable {
    private var root: [String: Any] = [:]

    func set(_ root: [String: Any]) {
        self.root = root
    }

    func value() -> [String: Any] {
        self.root
    }
}
