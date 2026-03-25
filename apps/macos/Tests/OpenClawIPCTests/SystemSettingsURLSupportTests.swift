import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct SystemSettingsURLSupportTests {
    @Test func `apple script reveals privacy screen capture anchor`() {
        let script = SystemSettingsURLSupport.appleScript(
            for: .init(
                paneID: "com.apple.settings.PrivacySecurity.extension",
                anchor: "Privacy_ScreenCapture"))

        #expect(script.contains("pane id \"com.apple.settings.PrivacySecurity.extension\""))
        #expect(script.contains("reveal anchor \"Privacy_ScreenCapture\" of paneRef"))
        #expect(script.contains("activate"))
    }

    @Test func `open uses reveal target before url fallback`() {
        var revealedTargets: [SystemSettingsURLSupport.RevealTarget] = []
        var openedURLs: [URL] = []
        let revealTarget = SystemSettingsURLSupport.RevealTarget(
            paneID: "com.apple.settings.PrivacySecurity.extension",
            anchor: "Privacy_Accessibility")

        let originalRevealRunner = SystemSettingsURLSupport.revealRunner
        let originalURLOpener = SystemSettingsURLSupport.urlOpener
        defer {
            SystemSettingsURLSupport.revealRunner = originalRevealRunner
            SystemSettingsURLSupport.urlOpener = originalURLOpener
        }

        SystemSettingsURLSupport.revealRunner = { target in
            revealedTargets.append(target)
            return true
        }
        SystemSettingsURLSupport.urlOpener = { url in
            openedURLs.append(url)
            return true
        }

        SystemSettingsURLSupport.open(
            revealTarget: revealTarget,
            fallbackCandidates: ["x-apple.systempreferences:com.apple.preference.security"])

        #expect(revealedTargets == [revealTarget])
        #expect(openedURLs.isEmpty)
    }

    @Test func `open falls back to urls when reveal target fails`() {
        var openedURLs: [URL] = []

        let originalRevealRunner = SystemSettingsURLSupport.revealRunner
        let originalURLOpener = SystemSettingsURLSupport.urlOpener
        defer {
            SystemSettingsURLSupport.revealRunner = originalRevealRunner
            SystemSettingsURLSupport.urlOpener = originalURLOpener
        }

        SystemSettingsURLSupport.revealRunner = { _ in false }
        SystemSettingsURLSupport.urlOpener = { url in
            openedURLs.append(url)
            return true
        }

        SystemSettingsURLSupport.open(
            revealTarget: .init(
                paneID: "com.apple.settings.PrivacySecurity.extension",
                anchor: "Privacy_ScreenCapture"),
            fallbackCandidates: [
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
                "x-apple.systempreferences:com.apple.preference.security",
            ])

        #expect(openedURLs.count == 1)
        #expect(openedURLs.first?.absoluteString == "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension")
    }
}
