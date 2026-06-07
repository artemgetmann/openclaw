import Foundation
import Testing
@testable import OpenClaw

struct OnboardingIconResourceLocatorTests {
    @Test
    func `packaged icon lookup uses copied resource bundle before module fallback`() throws {
        let fixture = try Self.makePackagedAppFixture(includeJarvisIcon: true)
        let bundle = try #require(Bundle(url: fixture.appURL))
        var evaluatedModuleFallback = false

        let url = OnboardingIconResourceLocator.consumerIconURL(mainBundle: bundle) {
            evaluatedModuleFallback = true
            return Bundle.main
        }

        #expect(url?.lastPathComponent == "Jarvis.icns")
        #expect(evaluatedModuleFallback == false)
    }

    @Test
    func `packaged icon lookup returns nil instead of evaluating module fallback when resource is missing`() throws {
        let fixture = try Self.makePackagedAppFixture(includeJarvisIcon: false)
        let bundle = try #require(Bundle(url: fixture.appURL))
        var evaluatedModuleFallback = false

        let url = OnboardingIconResourceLocator.consumerIconURL(mainBundle: bundle) {
            evaluatedModuleFallback = true
            return Bundle.main
        }

        #expect(url == nil)
        #expect(evaluatedModuleFallback == false)
    }

    private static func makePackagedAppFixture(includeJarvisIcon: Bool) throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-onboarding-icon-\(UUID().uuidString)", isDirectory: true)
        let appURL = root.appendingPathComponent("Jarvis Consumer Gate2.app", isDirectory: true)
        let resourcesURL = appURL.appendingPathComponent("Contents/Resources", isDirectory: true)
        let openClawResourceBundleURL = resourcesURL
            .appendingPathComponent("OpenClaw_OpenClaw.bundle", isDirectory: true)

        try FileManager.default.createDirectory(at: openClawResourceBundleURL, withIntermediateDirectories: true)
        try Self.writeInfoPlist(
            packageType: "APPL",
            to: appURL.appendingPathComponent("Contents/Info.plist"))
        try Self.writeInfoPlist(
            packageType: "BNDL",
            to: openClawResourceBundleURL.appendingPathComponent("Info.plist"))

        if includeJarvisIcon {
            try Data("fake icns bytes".utf8).write(to: openClawResourceBundleURL.appendingPathComponent("Jarvis.icns"))
        }

        return Fixture(appURL: appURL)
    }

    private static func writeInfoPlist(packageType: String, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>CFBundleIdentifier</key>
            <string>ai.openclaw.test.\(UUID().uuidString)</string>
            <key>CFBundleName</key>
            <string>OpenClawTest</string>
            <key>CFBundlePackageType</key>
            <string>\(packageType)</string>
        </dict>
        </plist>
        """
        try plist.write(to: url, atomically: true, encoding: .utf8)
    }

    private struct Fixture {
        let appURL: URL
    }
}
