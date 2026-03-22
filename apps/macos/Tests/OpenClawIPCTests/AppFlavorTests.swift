import Foundation
import Testing
@testable import OpenClaw

struct AppFlavorTests {
    @Test func `bundled app trusts bundle metadata over stale env override`() {
        let flavor = AppFlavor.resolve(
            environment: ["OPENCLAW_APP_VARIANT": "consumer"],
            infoDictionary: ["OpenClawAppVariant": "standard"],
            bundleIdentifier: "ai.openclaw.mac.debug",
            bundleURL: URL(fileURLWithPath: "/Applications/OpenClaw.app", isDirectory: true))

        #expect(flavor == .standard)
    }

    @Test func `non bundled tooling still respects env override`() {
        let flavor = AppFlavor.resolve(
            environment: ["OPENCLAW_APP_VARIANT": "consumer"],
            infoDictionary: ["OpenClawAppVariant": "standard"],
            bundleIdentifier: "ai.openclaw.mac.debug",
            bundleURL: URL(fileURLWithPath: "/tmp/OpenClawTests.xctest", isDirectory: true))

        #expect(flavor == .consumer)
    }
}
