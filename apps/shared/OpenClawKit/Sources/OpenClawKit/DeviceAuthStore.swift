import Foundation

public struct DeviceAuthEntry: Codable, Sendable {
    public let token: String
    public let role: String
    public let scopes: [String]
    public let updatedAtMs: Int

    public init(token: String, role: String, scopes: [String], updatedAtMs: Int) {
        self.token = token
        self.role = role
        self.scopes = scopes
        self.updatedAtMs = updatedAtMs
    }
}

private struct DeviceAuthStoreFile: Codable {
    var version: Int
    var deviceId: String
    var tokens: [String: DeviceAuthEntry]
}

public enum DeviceAuthStore {
    private static let fileName = "device-auth.json"
    private static let lock = NSLock()

    @discardableResult
    public static func reconcileMirroredAuth(deviceId: String, role: String) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }

        let normalizedRole = normalizeRole(role)
        let result = self.reconciledStoreForRead(deviceId: deviceId, role: normalizedRole)
        return result.repaired
    }

    public static func loadToken(deviceId: String, role: String) -> DeviceAuthEntry? {
        self.lock.lock()
        defer { self.lock.unlock() }

        let role = normalizeRole(role)
        guard let store = reconciledStoreForRead(deviceId: deviceId, role: role).store else { return nil }
        return store.tokens[role]
    }

    public static func storeToken(
        deviceId: String,
        role: String,
        token: String,
        scopes: [String] = []
    ) -> DeviceAuthEntry {
        self.lock.lock()
        defer { self.lock.unlock() }

        let normalizedRole = normalizeRole(role)
        var next = self.reconciledStoreForWrite(deviceId: deviceId, role: normalizedRole)
        if next?.deviceId != deviceId {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        let entry = DeviceAuthEntry(
            token: token,
            role: normalizedRole,
            scopes: normalizeScopes(scopes),
            updatedAtMs: Int(Date().timeIntervalSince1970 * 1000)
        )
        if next == nil {
            next = DeviceAuthStoreFile(version: 1, deviceId: deviceId, tokens: [:])
        }
        next?.tokens[normalizedRole] = entry
        if let store = next {
            writeCanonicalAndMirror(store)
        }
        return entry
    }

    public static func clearToken(deviceId: String, role: String) {
        self.lock.lock()
        defer { self.lock.unlock() }

        let normalizedRole = normalizeRole(role)
        guard var store = reconciledStoreForWrite(deviceId: deviceId, role: normalizedRole),
              store.deviceId == deviceId
        else { return }
        guard store.tokens[normalizedRole] != nil else { return }
        store.tokens.removeValue(forKey: normalizedRole)
        writeCanonicalAndMirror(store)
    }

    private static func normalizeRole(_ role: String) -> String {
        role.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizeScopes(_ scopes: [String]) -> [String] {
        let trimmed = scopes
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(Set(trimmed)).sorted()
    }

    private static func canonicalURL() -> URL {
        DeviceIdentityPaths.stateDirURL()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }

    private static func legacyMirrorURL() -> URL? {
        let stateDir = DeviceIdentityPaths.stateDirURL().standardizedFileURL
        guard stateDir.lastPathComponent == ".openclaw" else { return nil }
        return stateDir
            .deletingLastPathComponent()
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }

    private static func readStore(at url: URL) -> DeviceAuthStoreFile? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data) else {
            return nil
        }
        guard decoded.version == 1 else { return nil }
        return decoded
    }

    private static func hasUsableToken(
        _ store: DeviceAuthStoreFile?,
        deviceId: String,
        role: String
    ) -> Bool {
        guard let store, store.deviceId == deviceId else { return false }
        guard let token = store.tokens[role]?.token.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return false
        }
        return !token.isEmpty
    }

    private static func reconciledStoreForRead(
        deviceId: String,
        role: String
    ) -> (store: DeviceAuthStoreFile?, repaired: Bool) {
        let canonical = readStore(at: canonicalURL())
        // Canonical wins whenever it can authenticate the requested role. The
        // sibling OpenClaw/identity file is only a mirror, so stale legacy state
        // must be overwritten instead of imported back into `.openclaw`.
        if hasUsableToken(canonical, deviceId: deviceId, role: role) {
            if let canonical {
                writeLegacyMirror(canonical)
            }
            return (canonical, false)
        }

        guard let legacyURL = legacyMirrorURL() else {
            return (canonical, false)
        }
        let legacy = readStore(at: legacyURL)
        guard hasUsableToken(legacy, deviceId: deviceId, role: role), let legacy else {
            return (canonical, false)
        }

        // Legacy is allowed to heal only the missing role. Canonical owns the
        // complete token set once `.openclaw` exists, so a stale mirror must not
        // erase same-device node auth while donating an operator token.
        let repaired = mergeLegacyRoleIntoCanonical(
            canonical: canonical,
            legacy: legacy,
            deviceId: deviceId,
            role: role)
        writeCanonicalAndMirror(repaired)
        return (repaired, true)
    }

    private static func reconciledStoreForWrite(deviceId: String, role: String) -> DeviceAuthStoreFile? {
        let canonical = readStore(at: canonicalURL())
        // Writes should keep unrelated roles for the same device. This matters
        // when operator auth rotates but node auth is still valid.
        if canonical?.deviceId == deviceId {
            return canonical
        }
        guard let legacyURL = legacyMirrorURL() else {
            return canonical
        }
        let legacy = readStore(at: legacyURL)
        if hasUsableToken(legacy, deviceId: deviceId, role: role), let legacy {
            let repaired = mergeLegacyRoleIntoCanonical(
                canonical: canonical,
                legacy: legacy,
                deviceId: deviceId,
                role: role)
            writeCanonicalAndMirror(repaired)
            return repaired
        }
        return canonical
    }

    private static func mergeLegacyRoleIntoCanonical(
        canonical: DeviceAuthStoreFile?,
        legacy: DeviceAuthStoreFile,
        deviceId: String,
        role: String
    ) -> DeviceAuthStoreFile {
        guard canonical?.deviceId == deviceId else {
            return legacy
        }
        guard let legacyEntry = legacy.tokens[role] else {
            return canonical ?? legacy
        }

        var next = canonical!
        next.tokens[role] = legacyEntry
        return next
    }

    private static func writeCanonicalAndMirror(_ store: DeviceAuthStoreFile) {
        writeStore(store, to: canonicalURL())
        writeLegacyMirror(store)
    }

    private static func writeLegacyMirror(_ store: DeviceAuthStoreFile) {
        guard let url = legacyMirrorURL() else { return }
        writeStore(store, to: url)
    }

    private static func writeStore(_ store: DeviceAuthStoreFile, to url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(store)
            try data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            // best-effort only
        }
    }
}
