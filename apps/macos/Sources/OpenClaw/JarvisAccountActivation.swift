import Foundation
import Observation
import OpenClawKit

struct JarvisAccountActivationResponse: Equatable, Sendable {
    let accountId: String
    let email: String
    let accountAccessToken: String
    let licenseSummary: String?
}

enum JarvisAccountActivationError: LocalizedError, Equatable {
    case missingBaseURL
    case missingBackendAccessToken
    case invalidEmail
    case invalidOrExpired(String)
    case offline(String)
    case rejected(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .missingBaseURL:
            return "Jarvis activation is not configured for this build."
        case .missingBackendAccessToken:
            return "Jarvis activation is not enabled for this build."
        case .invalidEmail:
            return "Enter your email address."
        case let .invalidOrExpired(message):
            return message
        case let .offline(message):
            return message
        case let .rejected(message):
            return message
        case .invalidResponse:
            return "Jarvis sent an unreadable activation response. Try again."
        }
    }
}

struct JarvisAccountActivationClient: Sendable {
    struct Configuration: Sendable, Equatable {
        let baseURL: URL
        let backendAccessToken: String
    }

    typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

    private let configuration: Configuration
    private let transport: Transport

    init(
        configuration: Configuration,
        transport: @escaping Transport = JarvisAccountActivationClient.liveTransport
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

        guard let rawBaseURL else { throw JarvisAccountActivationError.missingBaseURL }
        guard let baseURL = URL(string: rawBaseURL) else { throw JarvisAccountActivationError.missingBaseURL }
        guard let rawAccessToken else { throw JarvisAccountActivationError.missingBackendAccessToken }
        return Configuration(baseURL: baseURL, backendAccessToken: rawAccessToken)
    }

    func login(email: String, deviceId: String = DeviceIdentityStore.loadOrCreate().deviceId) async throws
        -> JarvisAccountActivationResponse
    {
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedEmail.contains("@"), normalizedEmail.contains(".") else {
            throw JarvisAccountActivationError.invalidEmail
        }
        guard let url = URL(string: "/v1/account/login", relativeTo: self.configuration.baseURL)?.absoluteURL else {
            throw JarvisAccountActivationError.missingBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(self.configuration.backendAccessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(LoginBody(
            email: normalizedEmail,
            deviceId: deviceId,
            appVersion: Self.appVersionString(),
            platform: "macos"))

        do {
            let (data, response) = try await self.transport(request)
            guard (200..<300).contains(response.statusCode) else {
                throw Self.activationHTTPError(statusCode: response.statusCode, data: data)
            }
            let decoded = try JSONDecoder().decode(LoginResponse.self, from: data)
            guard !decoded.accountId.isEmpty,
                  !decoded.email.isEmpty,
                  !decoded.accountAccessToken.isEmpty
            else {
                throw JarvisAccountActivationError.invalidResponse
            }
            return JarvisAccountActivationResponse(
                accountId: decoded.accountId,
                email: decoded.email,
                accountAccessToken: decoded.accountAccessToken,
                licenseSummary: decoded.license?.summary)
        } catch let error as JarvisAccountActivationError {
            throw error
        } catch let error as DecodingError {
            _ = error
            throw JarvisAccountActivationError.invalidResponse
        } catch {
            throw JarvisAccountActivationError.offline("Jarvis could not connect. Check your internet and try again.")
        }
    }

    private static func liveTransport(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        let session = URLSession(configuration: configuration)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw JarvisAccountActivationError.offline("Jarvis could not read the activation response. Try again.")
        }
        return (data, http)
    }

    private static func firstNonEmptyString(_ values: Any?...) -> String? {
        for value in values {
            guard let string = value as? String else { continue }
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    private static func appVersionString() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "macos-app"
    }

    private static func activationHTTPError(statusCode: Int, data: Data) -> JarvisAccountActivationError {
        let fallback = statusCode == 401 || statusCode == 403
            ? JarvisAccountActivationCopy.inactiveEmail
            : "Jarvis could not activate this account. Try again in a moment."
        if statusCode == 401 || statusCode == 403 {
            let message = Self.httpErrorMessage(data: data) ?? fallback
            return .invalidOrExpired(message)
        }
        if statusCode == 409 {
            return .rejected(JarvisAccountActivationCopy.accountRecoveryUnavailable)
        }
        let message = Self.httpErrorMessage(data: data) ?? fallback
        return .rejected(message)
    }

    private static func httpErrorMessage(data: Data) -> String? {
        guard let decoded = try? JSONDecoder().decode(ErrorBody.self, from: data),
              let detail = decoded.detail?.trimmingCharacters(in: .whitespacesAndNewlines),
              !detail.isEmpty
        else {
            return nil
        }
        return detail
    }

    private struct LoginBody: Encodable {
        let email: String
        let deviceId: String
        let appVersion: String
        let platform: String
    }

    private struct LoginResponse: Decodable {
        let accountId: String
        let email: String
        let accountAccessToken: String
        let license: LicenseBody?
    }

    private struct LicenseBody: Decodable {
        let summary: String?

        init(from decoder: Decoder) throws {
            let value = try JSONValue(from: decoder)
            self.summary = value.summary
        }
    }

    private struct ErrorBody: Decodable {
        let detail: String?
    }
}

protocol JarvisAccountAccessTokenReading: Sendable {
    func loadAccountAccessToken() -> String?
}

protocol JarvisAccountAccessTokenStoring: JarvisAccountAccessTokenReading {
    func saveAccountAccessToken(_ token: String) throws
}

struct JarvisAccountActivationFileStore: JarvisAccountAccessTokenStoring {
    static let shared = JarvisAccountActivationFileStore()

    private static let tokenDirectoryName = "credentials"
    private static let tokenFileName = "jarvis-account-token"

    private let tokenFileURL: URL

    init(
        tokenFileURL: URL = Self.defaultTokenFileURL()
    ) {
        self.tokenFileURL = tokenFileURL
    }

    static func defaultTokenFileURL() -> URL {
        OpenClawPaths.stateDirURL
            .appendingPathComponent(Self.tokenDirectoryName, isDirectory: true)
            .appendingPathComponent(Self.tokenFileName, isDirectory: false)
    }

    func loadAccountAccessToken() -> String? {
        guard let data = try? Data(contentsOf: self.tokenFileURL),
              let token = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func saveAccountAccessToken(_ token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw JarvisAccountActivationError.invalidResponse }

        do {
            try self.ensureSecureParentDirectories()
            let data = Data(trimmed.utf8)
            let fileManager = FileManager.default
            if !fileManager.fileExists(atPath: self.tokenFileURL.path) {
                let created = fileManager.createFile(
                    atPath: self.tokenFileURL.path,
                    contents: nil,
                    attributes: [.posixPermissions: 0o600])
                guard created else { throw CocoaError(.fileWriteUnknown) }
            }
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.tokenFileURL.path)
            let handle = try FileHandle(forWritingTo: self.tokenFileURL)
            defer { try? handle.close() }
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: data)
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.tokenFileURL.path)
        } catch {
            throw JarvisAccountActivationError.rejected("Jarvis could not save activation securely. Try again.")
        }
    }

    private func ensureSecureParentDirectories() throws {
        // The state dir can be instance-scoped for UI smoke runs. Keep the
        // token bridge under that root so parallel app instances never share
        // account tokens, then harden only the app-owned directories we need.
        let stateDir = self.tokenFileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let tokenDir = self.tokenFileURL.deletingLastPathComponent()
        try self.ensureDirectoryExistsAndIsNotWorldWritable(stateDir, defaultPermissions: 0o700)
        try self.ensureDirectoryExistsAndIsNotWorldWritable(tokenDir, defaultPermissions: 0o700)
    }

    private func ensureDirectoryExistsAndIsNotWorldWritable(
        _ url: URL,
        defaultPermissions: Int
    ) throws {
        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: url.path) {
            try fileManager.createDirectory(
                at: url,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: defaultPermissions])
        }

        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        let currentPermissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? defaultPermissions
        let hardenedPermissions = currentPermissions & ~0o002
        if hardenedPermissions != currentPermissions {
            try fileManager.setAttributes(
                [.posixPermissions: hardenedPermissions],
                ofItemAtPath: url.path)
        }
    }
}

enum JarvisAccountActivationConfig {
    private static let accountTokenProviderName = "jarvis-account-token"
    private static let accountTokenRefId = "value"

    static func summary(root: [String: Any]) -> JarvisAccountActivationSummary? {
        guard let backend = (root["jarvis"] as? [String: Any])?["backend"] as? [String: Any],
              let account = backend["account"] as? [String: Any],
              let accountId = account["accountId"] as? String,
              let email = account["email"] as? String,
              !accountId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return JarvisAccountActivationSummary(
            accountId: accountId,
            email: email,
            licenseSummary: account["license"] as? String)
    }

    static func saveSummary(_ summary: JarvisAccountActivationSummary, into root: inout [String: Any]) {
        var jarvis = root["jarvis"] as? [String: Any] ?? [:]
        var backend = jarvis["backend"] as? [String: Any] ?? [:]
        backend["account"] = [
            "accountId": summary.accountId,
            "email": summary.email,
            "license": summary.licenseSummary ?? "",
        ]
        backend["accountAccessToken"] = Self.accountAccessTokenSecretRef()
        jarvis["backend"] = backend
        root["jarvis"] = jarvis
        Self.installAccountAccessTokenSecretProvider(into: &root)
    }

    static func configureManagedRuntime(into root: inout [String: Any], fallbackBaseURL: String? = nil) {
        var jarvis = root["jarvis"] as? [String: Any] ?? [:]
        var backend = jarvis["backend"] as? [String: Any] ?? [:]
        let existingBaseURL = (backend["baseUrl"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let envBaseURL = ProcessInfo.processInfo.environment["JARVIS_BACKEND_BASE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = fallbackBaseURL?.trimmingCharacters(in: .whitespacesAndNewlines)
        if existingBaseURL?.isEmpty != false {
            backend["baseUrl"] = [envBaseURL, fallback, "https://jarvis-backend-klvq.onrender.com"]
                .compactMap { $0 }
                .first { !$0.isEmpty }
        }

        // Node resolves SecretInput refs at runtime, so config points at the
        // app-owned token file without ever persisting the token as JSON.
        backend["accountAccessToken"] = Self.accountAccessTokenSecretRef()
        jarvis["backend"] = backend
        var managedServices = jarvis["managedServices"] as? [String: Any] ?? [:]
        managedServices["mode"] = "managed"
        jarvis["managedServices"] = managedServices
        root["jarvis"] = jarvis
        Self.installAccountAccessTokenSecretProvider(into: &root)
    }

    static func accountAccessTokenSecretRef() -> [String: String] {
        [
            "source": "file",
            "provider": Self.accountTokenProviderName,
            "id": Self.accountTokenRefId,
        ]
    }

    private static func installAccountAccessTokenSecretProvider(into root: inout [String: Any]) {
        var secrets = root["secrets"] as? [String: Any] ?? [:]
        var providers = secrets["providers"] as? [String: Any] ?? [:]
        providers[Self.accountTokenProviderName] = [
            "source": "file",
            "path": JarvisAccountActivationFileStore.defaultTokenFileURL().path,
            "mode": "singleValue",
        ]
        secrets["providers"] = providers
        root["secrets"] = secrets
    }
}

struct JarvisAccountActivationSummary: Equatable, Sendable {
    let accountId: String
    let email: String
    let licenseSummary: String?
}

@MainActor
@Observable
final class JarvisAccountActivationModel {
    enum State: Equatable {
        case idle
        case activating
        case activated(JarvisAccountActivationSummary)
        case failed(String)
    }

    var email: String
    var state: State

    private let loadConfig: @MainActor @Sendable () async -> [String: Any]
    private let saveConfig: @MainActor @Sendable ([String: Any]) async throws -> Void
    private let makeClient: @MainActor @Sendable ([String: Any]) throws -> JarvisAccountActivationClient
    private let tokenStore: JarvisAccountAccessTokenStoring

    init(
        email: String = "",
        state: State = .idle,
        tokenStore: JarvisAccountAccessTokenStoring = JarvisAccountActivationFileStore.shared,
        loadConfig: @escaping @MainActor @Sendable () async -> [String: Any] = { await ConfigStore.load() },
        saveConfig: @escaping @MainActor @Sendable ([String: Any]) async throws -> Void = { root in
            try await ConfigStore.save(root)
        },
        makeClient: @escaping @MainActor @Sendable ([String: Any]) throws -> JarvisAccountActivationClient = { root in
            try JarvisAccountActivationClient(configuration: JarvisAccountActivationClient.resolveConfiguration(root: root))
        }
    ) {
        self.email = email
        self.state = state
        self.tokenStore = tokenStore
        self.loadConfig = loadConfig
        self.saveConfig = saveConfig
        self.makeClient = makeClient
    }

    var isActivated: Bool {
        if case .activated = self.state {
            return true
        }
        return false
    }

    var canActivate: Bool {
        let trimmed = self.email.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && self.state != .activating
    }

    func loadStoredActivation() async {
        let root = await self.loadConfig()
        guard let summary = JarvisAccountActivationConfig.summary(root: root),
              self.tokenStore.loadAccountAccessToken() != nil
        else {
            return
        }
        self.email = summary.email
        self.state = .activated(summary)
    }

    func activate() async {
        guard self.canActivate else {
            self.state = .failed(JarvisAccountActivationError.invalidEmail.localizedDescription)
            return
        }

        self.state = .activating
        do {
            var root = await self.loadConfig()
            let client = try self.makeClient(root)
            let response = try await client.login(email: self.email)
            try self.tokenStore.saveAccountAccessToken(response.accountAccessToken)

            let summary = JarvisAccountActivationSummary(
                accountId: response.accountId,
                email: response.email,
                licenseSummary: response.licenseSummary)
            JarvisAccountActivationConfig.saveSummary(summary, into: &root)
            try await self.saveConfig(root)
            self.email = response.email
            self.state = .activated(summary)
        } catch let error as JarvisAccountActivationError {
            self.state = .failed(error.localizedDescription)
        } catch {
            self.state = .failed("Jarvis could not activate this account. Try again.")
        }
    }
}

private enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }

    var summary: String? {
        switch self {
        case let .string(value):
            return value
        case let .object(values):
            for key in ["status", "plan", "state", "type"] {
                if case let .string(value)? = values[key], !value.isEmpty {
                    return value
                }
            }
            return nil
        case .number, .bool, .array, .null:
            return nil
        }
    }
}
