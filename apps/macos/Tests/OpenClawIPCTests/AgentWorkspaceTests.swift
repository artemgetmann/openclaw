import Foundation
import Testing
@testable import OpenClaw

struct AgentWorkspaceTests {
    @Test
    func `display path uses tilde for home`() {
        let home = FileManager().homeDirectoryForCurrentUser
        #expect(AgentWorkspace.displayPath(for: home) == "~")

        let inside = home.appendingPathComponent("Projects", isDirectory: true)
        #expect(AgentWorkspace.displayPath(for: inside).hasPrefix("~/"))
    }

    @Test
    func `resolve workspace URL expands tilde`() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: "~/tmp")
        #expect(url.path.hasSuffix("/tmp"))
    }

    @Test
    func `agents URL appends filename`() {
        let root = URL(fileURLWithPath: "/tmp/ws", isDirectory: true)
        let url = AgentWorkspace.agentsURL(workspaceURL: root)
        #expect(url.lastPathComponent == AgentWorkspace.agentsFilename)
    }

    @Test
    func `bootstrap creates agents file when missing`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }

        let agentsURL = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(FileManager().fileExists(atPath: agentsURL.path))

        let contents = try String(contentsOf: agentsURL, encoding: .utf8)
        #expect(contents.contains("# AGENTS.md"))

        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        let userURL = tmp.appendingPathComponent(AgentWorkspace.userFilename)
        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        #expect(FileManager().fileExists(atPath: identityURL.path))
        #expect(FileManager().fileExists(atPath: userURL.path))
        #expect(FileManager().fileExists(atPath: bootstrapURL.path))

        let second = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(second == agentsURL)
    }

    @Test
    func `consumer bootstrap restores legacy Jarvis preset flow`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }

        _ = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        try AgentWorkspace.bootstrapConsumerJarvisPresetIfSafe(workspaceURL: tmp)

        let identity = try String(
            contentsOf: tmp.appendingPathComponent(AgentWorkspace.identityFilename),
            encoding: .utf8)
        let bootstrap = try String(
            contentsOf: tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename),
            encoding: .utf8)

        #expect(identity.contains("- **Name:**"))
        #expect(identity.contains("- **Role / persona:**"))
        #expect(identity.contains("- **Emoji/signature:**"))
        #expect(!identity.contains("- Name: Jarvis"))

        #expect(bootstrap.contains("1. What should I be called?"))
        #expect(bootstrap.contains("2. What role should I play for the human?"))
        #expect(bootstrap.contains("3. What vibe should I have most of the time?"))
        #expect(bootstrap.contains("4. What should I call the human?"))
        #expect(bootstrap.contains("5. Emoji/signature."))
        #expect(bootstrap.contains("offer a `Jarvis preset` vs `custom setup` choice"))
        #expect(bootstrap.contains("role = `engineering copilot + personal assistant`"))
        #expect(bootstrap.contains("do **not** ask role or vibe again"))
        #expect(bootstrap.contains("warm, capable, and memorable, not robotic"))
        #expect(bootstrap.contains("light dry wit"))
        #expect(bootstrap.contains("call out weak assumptions when appropriate"))
        #expect(!bootstrap.contains("Jarvis is already configured"))
        #expect(!bootstrap.contains("Who am I?"))
        #expect(!bootstrap.contains("What am I?"))
        #expect(!bootstrap.contains("creature/vibe"))
        #expect(!bootstrap.contains("chaos coordinator"))
        #expect(!bootstrap.contains("tiny menace"))
    }

    @Test
    func `consumer Jarvis preset preserves existing identity`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        try """
        # IDENTITY.md - Agent Identity

        - Name: Friday
        - Role / persona: Existing custom assistant
        """.write(to: identityURL, atomically: true, encoding: .utf8)

        try AgentWorkspace.bootstrapConsumerJarvisPresetIfSafe(workspaceURL: tmp)

        let identity = try String(contentsOf: identityURL, encoding: .utf8)
        #expect(identity.contains("- Name: Friday"))
        #expect(!identity.contains("- Name: Jarvis"))
    }

    @Test
    func `empty markdown identity labels do not count as customized`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        try AgentWorkspace.defaultIdentityTemplate().write(
            to: tmp.appendingPathComponent(AgentWorkspace.identityFilename),
            atomically: true,
            encoding: .utf8)
        try AgentWorkspace.defaultBootstrapTemplate().write(
            to: tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename),
            atomically: true,
            encoding: .utf8)

        #expect(!AgentWorkspace.hasIdentity(workspaceURL: tmp))
        #expect(AgentWorkspace.needsBootstrap(workspaceURL: tmp))
    }

    @Test
    func `bootstrap safety rejects non empty folder without agents`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let marker = tmp.appendingPathComponent("notes.txt")
        try "hello".write(to: marker, atomically: true, encoding: .utf8)

        let result = AgentWorkspace.bootstrapSafety(for: tmp)
        #expect(result.unsafeReason != nil)
    }

    @Test
    func `bootstrap safety allows existing agents file`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let agents = tmp.appendingPathComponent(AgentWorkspace.agentsFilename)
        try "# AGENTS.md".write(to: agents, atomically: true, encoding: .utf8)

        let result = AgentWorkspace.bootstrapSafety(for: tmp)
        #expect(result.unsafeReason == nil)
    }

    @Test
    func `bootstrap skips bootstrap file when workspace has content`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let marker = tmp.appendingPathComponent("notes.txt")
        try "hello".write(to: marker, atomically: true, encoding: .utf8)

        _ = try AgentWorkspace.bootstrap(workspaceURL: tmp)

        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        #expect(!FileManager().fileExists(atPath: bootstrapURL.path))
    }

    @Test
    func `needs bootstrap false when identity already set`() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        try """
        # IDENTITY.md - Agent Identity

        - Name: Clawd
        - Creature: Space Lobster
        - Vibe: Helpful
        - Emoji: lobster
        """.write(to: identityURL, atomically: true, encoding: .utf8)
        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        try "bootstrap".write(to: bootstrapURL, atomically: true, encoding: .utf8)

        #expect(!AgentWorkspace.needsBootstrap(workspaceURL: tmp))
    }
}
