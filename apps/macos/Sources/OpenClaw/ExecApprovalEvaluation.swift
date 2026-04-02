import Foundation

struct ExecApprovalEvaluation {
    let command: [String]
    let displayCommand: String
    let agentId: String?
    let security: ExecSecurity
    let ask: ExecAsk
    let env: [String: String]
    let resolution: ExecCommandResolution?
    let allowlistResolutions: [ExecCommandResolution]
    let allowlistMatches: [ExecAllowlistEntry]
    let allowlistSatisfied: Bool
    let allowlistMatch: ExecAllowlistEntry?
    let safeBinAllow: Bool
    let skillAllow: Bool
}

enum ExecApprovalEvaluator {
    static func evaluate(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        envOverrides: [String: String]?,
        agentId: String?) async -> ExecApprovalEvaluation
    {
        let trimmedAgent = agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAgentId = (trimmedAgent?.isEmpty == false) ? trimmedAgent : nil
        let approvals = ExecApprovalsStore.resolve(agentId: normalizedAgentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
        let shellWrapper = ExecShellWrapperParser.extract(command: command, rawCommand: rawCommand).isWrapper
        let env = HostEnvSanitizer.sanitize(overrides: envOverrides, shellWrapper: shellWrapper)
        let displayCommand = ExecCommandFormatter.displayString(for: command, rawCommand: rawCommand)
        let allowlistResolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: rawCommand,
            cwd: cwd,
            env: env)
        let allowlistMatches = security == .allowlist
            ? ExecAllowlistMatcher.matchAll(entries: approvals.allowlist, resolutions: allowlistResolutions)
            : []
        let allowlistSatisfied = security == .allowlist &&
            !allowlistResolutions.isEmpty &&
            allowlistMatches.count == allowlistResolutions.count

        // The macOS node host needs the same safe-bin affordance as the gateway
        // exec path. Consumer cleanroom wrappers like `wacli` are intentionally
        // not broad allowlist entries; they are constrained by bin name, trusted
        // directory, and argv shape.
        let safeBinPolicy = ExecSafeBins.resolvePolicy(env: env)
        let safeBinAllow = command.count > 0 &&
            !allowlistResolutions.isEmpty &&
            allowlistResolutions.count == 1 &&
            ExecSafeBins.isAllowed(
                command: command,
                resolution: allowlistResolutions.first,
                policy: safeBinPolicy)

        let skillAllow: Bool
        if approvals.agent.autoAllowSkills, !allowlistResolutions.isEmpty {
            let bins = await SkillBinsCache.shared.currentTrust()
            skillAllow = self.isSkillAutoAllowed(allowlistResolutions, trustedBinsByName: bins)
        } else {
            skillAllow = false
        }

        return ExecApprovalEvaluation(
            command: command,
            displayCommand: displayCommand,
            agentId: normalizedAgentId,
            security: security,
            ask: ask,
            env: env,
            resolution: allowlistResolutions.first,
            allowlistResolutions: allowlistResolutions,
            allowlistMatches: allowlistMatches,
            allowlistSatisfied: allowlistSatisfied,
            allowlistMatch: allowlistSatisfied ? allowlistMatches.first : nil,
            safeBinAllow: safeBinAllow,
            skillAllow: skillAllow)
    }

    static func isSkillAutoAllowed(
        _ resolutions: [ExecCommandResolution],
        trustedBinsByName: [String: Set<String>]) -> Bool
    {
        guard !resolutions.isEmpty, !trustedBinsByName.isEmpty else { return false }
        return resolutions.allSatisfy { resolution in
            guard let executableName = SkillBinsCache.normalizeSkillBinName(resolution.executableName),
                  let resolvedPath = SkillBinsCache.normalizeResolvedPath(resolution.resolvedPath)
            else {
                return false
            }
            return trustedBinsByName[executableName]?.contains(resolvedPath) == true
        }
    }

    static func _testIsSkillAutoAllowed(
        _ resolutions: [ExecCommandResolution],
        trustedBinsByName: [String: Set<String>]) -> Bool
    {
        self.isSkillAutoAllowed(resolutions, trustedBinsByName: trustedBinsByName)
    }
}
