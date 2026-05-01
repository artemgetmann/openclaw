import CryptoKit
import Foundation

public struct DeviceIdentity: Codable, Sendable {
    public var deviceId: String
    public var publicKey: String
    public var privateKey: String
    public var createdAtMs: Int

    public init(deviceId: String, publicKey: String, privateKey: String, createdAtMs: Int) {
        self.deviceId = deviceId
        self.publicKey = publicKey
        self.privateKey = privateKey
        self.createdAtMs = createdAtMs
    }
}

private struct DeviceIdentityAuthFile: Codable {
    let version: Int
    let deviceId: String
    let tokens: [String: DeviceAuthEntry]
}

enum DeviceIdentityPaths {
    private static let stateDirEnv = ["OPENCLAW_STATE_DIR"]

    static func stateDirURL() -> URL {
        for key in self.stateDirEnv {
            if let raw = getenv(key) {
                let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    return URL(fileURLWithPath: value, isDirectory: true)
                }
            }
        }

        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            return appSupport.appendingPathComponent("OpenClaw", isDirectory: true)
        }

        return FileManager.default.temporaryDirectory.appendingPathComponent("openclaw", isDirectory: true)
    }
}

public enum DeviceIdentityStore {
    private static let fileName = "device.json"
    private static let authFileName = "device-auth.json"

    public static func loadOrCreate() -> DeviceIdentity {
        let url = self.fileURL()
        if let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(DeviceIdentity.self, from: data),
           !decoded.deviceId.isEmpty,
           !decoded.publicKey.isEmpty,
           !decoded.privateKey.isEmpty {
            return decoded
        }
        let identity = self.generate()
        self.save(identity)
        return identity
    }

    @discardableResult
    public static func migrateLegacyAppSupportIdentityIfNeeded() -> Bool {
        let stateDir = DeviceIdentityPaths.stateDirURL().standardizedFileURL
        guard stateDir.lastPathComponent == ".openclaw" else { return false }

        // Pre-cutover macOS builds stored the paired UI identity beside the runtime root.
        // Copy it into `.openclaw` only when the canonical identity cannot authenticate.
        let currentDir = stateDir.appendingPathComponent("identity", isDirectory: true)
        let legacyDir = stateDir
            .deletingLastPathComponent()
            .appendingPathComponent("identity", isDirectory: true)
        let currentDeviceURL = currentDir.appendingPathComponent(fileName, isDirectory: false)
        let currentAuthURL = currentDir.appendingPathComponent(authFileName, isDirectory: false)
        let legacyDeviceURL = legacyDir.appendingPathComponent(fileName, isDirectory: false)
        let legacyAuthURL = legacyDir.appendingPathComponent(authFileName, isDirectory: false)

        guard
            let legacyIdentity = self.loadIdentity(at: legacyDeviceURL),
            self.authFile(at: legacyAuthURL, hasTokenFor: legacyIdentity.deviceId, role: "operator")
        else {
            return false
        }

        if let currentIdentity = self.loadIdentity(at: currentDeviceURL),
           self.authFile(at: currentAuthURL, hasTokenFor: currentIdentity.deviceId, role: "operator")
        {
            return false
        }

        do {
            try FileManager.default.createDirectory(at: currentDir, withIntermediateDirectories: true)
            try Data(contentsOf: legacyDeviceURL).write(to: currentDeviceURL, options: [.atomic])
            try Data(contentsOf: legacyAuthURL).write(to: currentAuthURL, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: currentDeviceURL.path)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: currentAuthURL.path)
            return true
        } catch {
            return false
        }
    }

    public static func signPayload(_ payload: String, identity: DeviceIdentity) -> String? {
        guard let privateKeyData = Data(base64Encoded: identity.privateKey) else { return nil }
        do {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKeyData)
            let signature = try privateKey.signature(for: Data(payload.utf8))
            return self.base64UrlEncode(signature)
        } catch {
            return nil
        }
    }

    private static func generate() -> DeviceIdentity {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey
        let publicKeyData = publicKey.rawRepresentation
        let privateKeyData = privateKey.rawRepresentation
        let deviceId = SHA256.hash(data: publicKeyData).compactMap { String(format: "%02x", $0) }.joined()
        return DeviceIdentity(
            deviceId: deviceId,
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: Int(Date().timeIntervalSince1970 * 1000))
    }

    private static func base64UrlEncode(_ data: Data) -> String {
        let base64 = data.base64EncodedString()
        return base64
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func publicKeyBase64Url(_ identity: DeviceIdentity) -> String? {
        guard let data = Data(base64Encoded: identity.publicKey) else { return nil }
        return self.base64UrlEncode(data)
    }

    private static func save(_ identity: DeviceIdentity) {
        let url = self.fileURL()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(identity)
            try data.write(to: url, options: [.atomic])
        } catch {
            // best-effort only
        }
    }

    private static func loadIdentity(at url: URL) -> DeviceIdentity? {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(DeviceIdentity.self, from: data),
              !decoded.deviceId.isEmpty,
              !decoded.publicKey.isEmpty,
              !decoded.privateKey.isEmpty
        else {
            return nil
        }
        return decoded
    }

    private static func authFile(at url: URL, hasTokenFor deviceId: String, role: String) -> Bool {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(DeviceIdentityAuthFile.self, from: data),
              decoded.version == 1,
              decoded.deviceId == deviceId
        else {
            return false
        }
        let normalizedRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let token = decoded.tokens[normalizedRole]?.token.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return false
        }
        return !token.isEmpty
    }

    private static func fileURL() -> URL {
        let base = DeviceIdentityPaths.stateDirURL()
        return base
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }
}
