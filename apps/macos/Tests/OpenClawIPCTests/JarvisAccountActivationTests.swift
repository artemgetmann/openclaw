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

    @Test func `activation model stores token securely without writing rejected keychain exec provider`() async throws {
        let tokenStore = MockAccountTokenStore()
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
                            "accountAccessToken": [
                                "source": "exec",
                                "provider": "jarvis-keychain",
                                "id": "account-access-token",
                            ],
                        ],
                    ],
                    "secrets": [
                        "providers": [
                            "jarvis-keychain": [
                                "source": "exec",
                                "command": "/usr/bin/security",
                            ],
                            "other-provider": [
                                "source": "env",
                            ],
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

        #expect(tokenStore.loadAccountAccessToken() == "jat_secret")
        #expect(model.isActivated)

        let backend = try #require((savedRoot.value()["jarvis"] as? [String: Any])?["backend"] as? [String: Any])
        let account = try #require(backend["account"] as? [String: Any])
        #expect(account["accountId"] as? String == "acct_123")
        #expect(account["email"] as? String == "user@example.com")
        #expect(account["license"] as? String == "beta")
        #expect(backend["accountAccessToken"] == nil)
        let providers = try #require((savedRoot.value()["secrets"] as? [String: Any])?["providers"] as? [String: Any])
        #expect(providers["jarvis-keychain"] == nil)
        #expect((providers["other-provider"] as? [String: Any])?["source"] as? String == "env")
    }

    @Test func `activation model reads current app config instead of stale ConfigStore snapshot`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-activation-\(UUID().uuidString)", isDirectory: true)
        let configURL = tempDir.appendingPathComponent("openclaw.json")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try Self.writeConfig([
            "jarvis": [
                "backend": [
                    "baseUrl": "https://current.jarvis.example",
                    "accessToken": "current-valid-token",
                ],
            ],
        ], to: configURL)

        let tokenStore = MockAccountTokenStore()
        var resolvedToken: String?

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configURL.path,
            "OPENCLAW_STATE_DIR": tempDir.path,
        ]) {
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { false },
                loadRemote: {
                    [
                        "jarvis": [
                            "backend": [
                                "baseUrl": "https://stale.jarvis.example",
                                "accessToken": "stale-invalid-token",
                            ],
                        ],
                    ]
                },
                saveRemote: { _ in
                    Issue.record("activation should not write through stale gateway config")
                }))

            let model = JarvisAccountActivationModel(
                email: "user@example.com",
                tokenStore: tokenStore,
                makeClient: { root in
                    let configuration = try JarvisAccountActivationClient.resolveConfiguration(root: root)
                    resolvedToken = configuration.backendAccessToken
                    return JarvisAccountActivationClient(
                        configuration: configuration,
                        transport: { request in
                            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer current-valid-token")
                            return try Self.httpResponse(
                                url: #require(request.url),
                                statusCode: 200,
                                body: """
                                {
                                  "accountId": "acct_current",
                                  "email": "user@example.com",
                                  "accountAccessToken": "jat_current",
                                  "license": { "plan": "beta" }
                                }
                                """)
                        })
                })

            await model.activate()
            await ConfigStore._testClearOverrides()
        }

        #expect(resolvedToken == "current-valid-token")
        #expect(tokenStore.loadAccountAccessToken() == "jat_current")

        let saved = try Self.readConfig(configURL)
        let backend = try #require((saved["jarvis"] as? [String: Any])?["backend"] as? [String: Any])
        let account = try #require(backend["account"] as? [String: Any])
        #expect(account["accountId"] as? String == "acct_current")
        #expect(backend["accessToken"] as? String == "current-valid-token")
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

        #expect(configuration.accountAccessToken == "jat_stored")
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

    private static func writeConfig(_ root: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url)
    }

    private static func readConfig(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
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
