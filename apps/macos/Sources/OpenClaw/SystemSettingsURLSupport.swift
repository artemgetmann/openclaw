import AppKit
import Foundation

enum SystemSettingsURLSupport {
    struct RevealTarget: Equatable {
        let paneID: String
        let anchor: String?
    }

    nonisolated(unsafe) static var revealRunner: (RevealTarget) -> Bool = { target in
        SystemSettingsURLSupport.runRevealScript(target)
    }

    nonisolated(unsafe) static var urlOpener: (URL) -> Bool = { url in
        NSWorkspace.shared.open(url)
    }

    static func openFirst(_ candidates: [String]) {
        for candidate in candidates {
            if let url = URL(string: candidate), self.urlOpener(url) {
                return
            }
        }
    }

    static func open(
        revealTarget: RevealTarget?,
        fallbackCandidates: [String])
    {
        // System Settings can ignore plain x-apple URLs when it is already
        // focused on another Privacy subpage (for example Location Services).
        // A direct pane/anchor reveal is the reliable way to move the existing
        // window to the permission the user actually needs.
        if let revealTarget, self.revealRunner(revealTarget) {
            return
        }
        self.openFirst(fallbackCandidates)
    }

    private static func runRevealScript(_ target: RevealTarget) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", self.appleScript(for: target)]

        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    static func appleScript(for target: RevealTarget) -> String {
        let paneID = self.appleScriptLiteral(target.paneID)
        if let anchor = target.anchor {
            let anchorValue = self.appleScriptLiteral(anchor)
            return """
            tell application "System Settings"
                set paneRef to pane id \(paneID)
                reveal anchor \(anchorValue) of paneRef
                activate
            end tell
            """
        }

        return """
        tell application "System Settings"
            set paneRef to pane id \(paneID)
            reveal paneRef
            activate
        end tell
        """
    }

    private static func appleScriptLiteral(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
    }
}
