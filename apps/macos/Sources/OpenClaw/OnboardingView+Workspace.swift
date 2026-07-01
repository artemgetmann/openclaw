import Foundation

extension OnboardingView {
    func loadWorkspaceDefaults() async {
        guard self.workspacePath.isEmpty else { return }
        let configured = await self.loadAgentWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        self.workspacePath = AgentWorkspace.displayPath(for: url)
        self.refreshBootstrapStatus()
    }

    func ensureDefaultWorkspace() async {
        guard self.state.connectionMode == .local else { return }
        let configured = await self.loadAgentWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        let safety = AgentWorkspace.bootstrapSafety(for: url)
        if let reason = safety.unsafeReason {
            self.workspaceStatus = "Workspace not touched: \(reason)"
        } else {
            do {
                _ = try AgentWorkspace.bootstrap(workspaceURL: url)
                if (configured ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    await self.saveAgentWorkspace(AgentWorkspace.displayPath(for: url))
                }
            } catch {
                self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
            }
        }
        self.refreshBootstrapStatus()
    }

    func refreshBootstrapStatus() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
        self.needsBootstrap = AgentWorkspace.needsBootstrap(workspaceURL: url)
        if self.needsBootstrap {
            self.didAutoKickoff = false
        }
    }

    var workspaceBootstrapCommand: String {
        let template = AgentWorkspace.defaultTemplate().trimmingCharacters(in: .whitespacesAndNewlines)
        let workspace = Self.workspaceBootstrapShellPath(for: OpenClawConfigFile.defaultWorkspaceURL())
        return """
        workspace="\(workspace)"
        mkdir -p "$workspace"
        cat > "$workspace/AGENTS.md" <<'EOF'
        \(template)
        EOF
        """
    }

    private static func workspaceBootstrapShellPath(for url: URL) -> String {
        let home = FileManager().homeDirectoryForCurrentUser.path
        let path = url.path
        if path == home { return "$HOME" }
        if path.hasPrefix(home + "/") {
            // Keep copied remote commands portable while still quoting spaces
            // safely. Only the literal $HOME prefix should expand in the shell.
            let relative = String(path.dropFirst(home.count + 1))
            return "$HOME/\(self.escapeDoubleQuotedShellContent(relative))"
        }
        return self.escapeDoubleQuotedShellContent(path)
    }

    private static func escapeDoubleQuotedShellContent(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "`", with: "\\`")
            .replacingOccurrences(of: "$", with: "\\$")
    }

    func applyWorkspace() async {
        guard !self.workspaceApplying else { return }
        self.workspaceApplying = true
        defer { self.workspaceApplying = false }

        do {
            let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
            if let reason = AgentWorkspace.bootstrapSafety(for: url).unsafeReason {
                self.workspaceStatus = "Workspace not created: \(reason)"
                return
            }
            _ = try AgentWorkspace.bootstrap(workspaceURL: url)
            self.workspacePath = AgentWorkspace.displayPath(for: url)
            self.workspaceStatus = "Workspace ready at \(self.workspacePath)"
            self.refreshBootstrapStatus()
        } catch {
            self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
        }
    }

    private func loadAgentWorkspace() async -> String? {
        let root = await ConfigStore.load()
        return AgentWorkspaceConfig.workspace(from: root)
    }

    @discardableResult
    func saveAgentWorkspace(_ workspace: String?) async -> Bool {
        let (success, errorMessage) = await OnboardingView.buildAndSaveWorkspace(workspace)

        if let errorMessage {
            self.workspaceStatus = errorMessage
        }
        return success
    }

    @MainActor
    private static func buildAndSaveWorkspace(_ workspace: String?) async -> (Bool, String?) {
        var root = await ConfigStore.load()
        AgentWorkspaceConfig.setWorkspace(in: &root, workspace: workspace)
        do {
            try await ConfigStore.save(root)
            return (true, nil)
        } catch {
            let errorMessage = "Failed to save config: \(error.localizedDescription)"
            return (false, errorMessage)
        }
    }
}
