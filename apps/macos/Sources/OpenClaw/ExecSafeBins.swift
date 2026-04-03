import Foundation

struct ExecSafeBinProfile {
    let minPositional: Int?
    let maxPositional: Int?
    let allowedValueFlags: Set<String>
    let deniedFlags: Set<String>
}

struct ExecSafeBinPolicy {
    let safeBins: Set<String>
    let profilesByName: [String: ExecSafeBinProfile]
    let trustedDirs: Set<String>
}

enum ExecSafeBins {
    private static let defaultTrustedDirs: Set<String> = [
        "/bin",
        "/usr/bin",
    ]

    static func resolvePolicy(
        root: [String: Any] = OpenClawConfigFile.loadDict(),
        env: [String: String]
    ) -> ExecSafeBinPolicy {
        let exec = (((root["tools"] as? [String: Any])?["exec"] as? [String: Any]) ?? [:])
        let safeBins = Set(
            ((exec["safeBins"] as? [Any]) ?? [])
                .compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty })

        let profileFixtures = (exec["safeBinProfiles"] as? [String: Any]) ?? [:]
        var profilesByName: [String: ExecSafeBinProfile] = [:]
        for (rawName, fixtureValue) in profileFixtures {
            let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !name.isEmpty, let fixture = fixtureValue as? [String: Any] else { continue }
            profilesByName[name] = ExecSafeBinProfile(
                minPositional: self.readNonNegativeInt(fixture["minPositional"]),
                maxPositional: self.readNonNegativeInt(fixture["maxPositional"]),
                allowedValueFlags: self.readFlagSet(fixture["allowedValueFlags"]),
                deniedFlags: self.readFlagSet(fixture["deniedFlags"]))
        }

        var trustedDirs = self.defaultTrustedDirs
        if let servicePrefix = env["OPENCLAW_SERVICE_PATH_PREFIX"]?
            .split(separator: ":")
            .map({ String($0).trimmingCharacters(in: .whitespacesAndNewlines) })
        {
            for rawDir in servicePrefix where !rawDir.isEmpty {
                trustedDirs.insert(URL(fileURLWithPath: rawDir).standardizedFileURL.path)
            }
        }
        if let stateDir = env["OPENCLAW_STATE_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stateDir.isEmpty
        {
            trustedDirs.insert(URL(fileURLWithPath: stateDir).appendingPathComponent("bin").standardizedFileURL.path)
            trustedDirs.insert(
                URL(fileURLWithPath: stateDir)
                    .appendingPathComponent("tools", isDirectory: true)
                    .appendingPathComponent("node", isDirectory: true)
                    .appendingPathComponent("bin", isDirectory: true)
                    .standardizedFileURL.path)
        }

        return ExecSafeBinPolicy(
            safeBins: safeBins,
            profilesByName: profilesByName,
            trustedDirs: trustedDirs)
    }

    static func isAllowed(
        command: [String],
        resolution: ExecCommandResolution?,
        policy: ExecSafeBinPolicy
    ) -> Bool {
        guard let resolution, !command.isEmpty else { return false }
        let executableName = resolution.executableName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard policy.safeBins.contains(executableName) else { return false }
        guard let resolvedPath = resolution.resolvedPath?.trimmingCharacters(in: .whitespacesAndNewlines),
              !resolvedPath.isEmpty
        else {
            return false
        }

        // Safe-bin trust is explicit. We only accept bins that resolve inside
        // OS-managed directories or the lane-local cleanroom directories
        // injected by the consumer runtime.
        let resolvedDir = URL(fileURLWithPath: resolvedPath).deletingLastPathComponent().standardizedFileURL.path
        guard policy.trustedDirs.contains(resolvedDir) else { return false }

        // Some consumer-local CLIs (for example gog/himalaya) are intentionally
        // trusted as whole binaries once they resolve inside the lane-local
        // service prefix. Others (notably wacli) still need per-flag fences
        // because the product contract only supports a narrower surface.
        guard let profile = policy.profilesByName[executableName] else { return true }
        return self.validateArgs(Array(command.dropFirst()), profile: profile)
    }

    static func _testResolvePolicy(root: [String: Any], env: [String: String]) -> ExecSafeBinPolicy {
        self.resolvePolicy(root: root, env: env)
    }

    static func _testIsAllowed(
        command: [String],
        resolution: ExecCommandResolution?,
        policy: ExecSafeBinPolicy
    ) -> Bool {
        self.isAllowed(command: command, resolution: resolution, policy: policy)
    }

    private static func readNonNegativeInt(_ value: Any?) -> Int? {
        if let intValue = value as? Int, intValue >= 0 { return intValue }
        if let number = value as? NSNumber {
            let intValue = number.intValue
            return intValue >= 0 ? intValue : nil
        }
        return nil
    }

    private static func readFlagSet(_ value: Any?) -> Set<String> {
        Set(
            ((value as? [Any]) ?? [])
                .compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty })
    }

    private static func isPathLike(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "-" { return false }
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("./") || trimmed.hasPrefix("../") || trimmed.hasPrefix("~") {
            return true
        }
        return trimmed.contains("/") || trimmed.contains("\\")
    }

    private static func hasGlob(_ token: String) -> Bool {
        token.contains("*") || token.contains("?") || token.contains("[")
    }

    private static func isSafeLiteral(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "-" { return true }
        return !self.hasGlob(trimmed) && !self.isPathLike(trimmed)
    }

    private static func consumePositional(_ token: String, positional: inout [String]) -> Bool {
        guard self.isSafeLiteral(token) else { return false }
        positional.append(token)
        return true
    }

    private static func validateArgs(_ args: [String], profile: ExecSafeBinProfile) -> Bool {
        var positional: [String] = []
        var index = 0

        while index < args.count {
            let rawToken = args[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if rawToken.isEmpty || rawToken == "-" {
                index += 1
                continue
            }

            if rawToken == "--" {
                for rest in args.dropFirst(index + 1) {
                    guard self.consumePositional(rest, positional: &positional) else { return false }
                }
                break
            }

            if rawToken.hasPrefix("--") {
                let parts = rawToken.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                let flag = String(parts[0])
                if profile.deniedFlags.contains(flag) { return false }
                if parts.count == 2 {
                    guard profile.allowedValueFlags.contains(flag), self.isSafeLiteral(String(parts[1])) else {
                        return false
                    }
                    index += 1
                    continue
                }
                if profile.allowedValueFlags.contains(flag) {
                    guard index + 1 < args.count, self.isSafeLiteral(args[index + 1]) else { return false }
                    index += 2
                    continue
                }
                index += 1
                continue
            }

            if rawToken.hasPrefix("-"), rawToken.count > 1 {
                let cluster = Array(rawToken.dropFirst())
                var consumedValue = false
                for (offset, shortFlag) in cluster.enumerated() {
                    let flag = "-\(shortFlag)"
                    if profile.deniedFlags.contains(flag) { return false }
                    if profile.allowedValueFlags.contains(flag) {
                        let inlineValue = String(cluster.dropFirst(offset + 1))
                        if !inlineValue.isEmpty {
                            guard self.isSafeLiteral(inlineValue) else { return false }
                        } else {
                            guard index + 1 < args.count, self.isSafeLiteral(args[index + 1]) else { return false }
                            index += 1
                        }
                        consumedValue = true
                        break
                    }
                }
                index += 1
                if consumedValue {
                    continue
                }
                continue
            }

            guard self.consumePositional(rawToken, positional: &positional) else { return false }
            index += 1
        }

        if let minPositional = profile.minPositional, positional.count < minPositional { return false }
        if let maxPositional = profile.maxPositional, positional.count > maxPositional { return false }
        return true
    }
}
