import Foundation
import OpenClawKit

struct JarvisTelegramManagedStartResponse: Decodable, Equatable {
    let setupId: String
    let approvalUrl: String
    let suggestedBotUsername: String
    let expiresAt: Date
    let status: String
}

struct JarvisTelegramManagedStatusResponse: Decodable, Equatable {
    let setupId: String
    let expiresAt: Date
    let status: String
    let suggestedBotUsername: String
    let botId: Int?
    let botUsername: String?
    let managedChildBotToken: String?
}

enum JarvisTelegramManagedBotClientError: LocalizedError {
    case missingBaseURL
    case missingAccessToken
    case invalidURL
    case http(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .missingBaseURL:
            return "Jarvis bot setup is not configured yet."
        case .missingAccessToken:
            return "Sign in to Jarvis before creating a Telegram bot."
        case .invalidURL:
            return "Jarvis bot setup could not build a valid request."
        case let .http(message):
            return message
        case let .transport(message):
            return "Jarvis bot setup could not connect. \(message)"
        }
    }
}

struct JarvisTelegramManagedBotClient: Sendable {
    struct Configuration: Sendable, Equatable {
        let baseURL: URL
        let accessToken: String
        let accountAccessToken: String?
    }

    typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

    private let configuration: Configuration
    private let transport: Transport

    init(
        configuration: Configuration,
        transport: @escaping Transport = JarvisTelegramManagedBotClient.defaultTransport
    ) {
        self.configuration = configuration
        self.transport = transport
    }

    static func resolveConfiguration(root: [String: Any]) throws -> Configuration {
        let env = ProcessInfo.processInfo.environment
        let backend = ((root["jarvis"] as? [String: Any])?["backend"] as? [String: Any]) ?? [:]
        let rawBaseURL = Self.firstNonEmptyString(
            backend["baseUrl"],
            env["JARVIS_BACKEND_BASE_URL"],
            "https://jarvis-backend-klvq.onrender.com")
        let rawAccessToken = Self.firstNonEmptyString(
            backend["accessToken"],
            env["JARVIS_BACKEND_ACCESS_TOKEN"],
            env["JARVIS_BACKEND_API_TOKEN"])
        let rawAccountAccessToken = Self.firstNonEmptyString(
            backend["accountAccessToken"],
            env["JARVIS_ACCOUNT_ACCESS_TOKEN"])

        guard let rawBaseURL else {
            throw JarvisTelegramManagedBotClientError.missingBaseURL
        }
        guard let baseURL = URL(string: rawBaseURL) else {
            throw JarvisTelegramManagedBotClientError.invalidURL
        }
        guard let rawAccessToken else {
            throw JarvisTelegramManagedBotClientError.missingAccessToken
        }
        return Configuration(
            baseURL: baseURL,
            accessToken: rawAccessToken,
            accountAccessToken: rawAccountAccessToken)
    }

    func start(suggestedBotName: String, suggestedBotUsername: String? = nil) async throws
        -> JarvisTelegramManagedStartResponse
    {
        var body: [String: String] = [
            "suggestedBotName": suggestedBotName,
            "appVersion": Self.appVersionString(),
            "deviceId": DeviceIdentityStore.loadOrCreate().deviceId,
        ]
        if let accountAccessToken = self.configuration.accountAccessToken {
            body["accountAccessToken"] = accountAccessToken
        }
        if let suggestedBotUsername,
           !suggestedBotUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            body["suggestedBotUsername"] = suggestedBotUsername
        }

        var request = try self.request(path: "/v1/telegram/managed/start", method: "POST")
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await self.send(request)
    }

    func status(setupId: String) async throws -> JarvisTelegramManagedStatusResponse {
        let encodedSetupId = setupId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? setupId
        let request = try self.request(
            path: "/v1/telegram/managed/status/\(encodedSetupId)",
            method: "GET")
        return try await self.send(request)
    }

    private func request(path: String, method: String) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: self.configuration.baseURL)?.absoluteURL else {
            throw JarvisTelegramManagedBotClientError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("Bearer \(self.configuration.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        do {
            let (data, response) = try await self.transport(request)
            guard (200..<300).contains(response.statusCode) else {
                throw JarvisTelegramManagedBotClientError.http(Self.httpErrorMessage(data: data))
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(Response.self, from: data)
        } catch let error as JarvisTelegramManagedBotClientError {
            throw error
        } catch {
            throw JarvisTelegramManagedBotClientError.transport(error.localizedDescription)
        }
    }

    private static func liveTransport(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        let session = URLSession(configuration: configuration)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw JarvisTelegramManagedBotClientError.transport("Missing HTTP response.")
        }
        return (data, http)
    }

    private static func defaultTransport(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        #if DEBUG
        if let override = await TestTransportOverride.shared.transport {
            return try await override(request)
        }
        #endif
        return try await self.liveTransport(request)
    }

    private static func firstNonEmptyString(_ values: Any?...) -> String? {
        for value in values {
            if let string = value as? String {
                let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    return trimmed
                }
            }
        }
        return nil
    }

    private static func appVersionString() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "macos-app"
    }

    private static func httpErrorMessage(data: Data) -> String {
        struct ErrorBody: Decodable {
            let detail: String?
        }
        if let decoded = try? JSONDecoder().decode(ErrorBody.self, from: data),
           let detail = decoded.detail,
           !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return detail
        }
        return "Jarvis bot setup was rejected. Try again in a moment."
    }
}

#if DEBUG
private actor TestTransportOverride {
    static let shared = TestTransportOverride()
    var transport: JarvisTelegramManagedBotClient.Transport?

    func set(_ transport: JarvisTelegramManagedBotClient.Transport?) {
        self.transport = transport
    }
}

extension JarvisTelegramManagedBotClient {
    static func _testSetTransportOverride(_ transport: Transport?) async {
        await TestTransportOverride.shared.set(transport)
    }
}
#endif
