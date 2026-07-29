import Foundation
import Testing
@testable import OpenClaw

struct AppUpdateRestartTests {
    @Test func `restart marker is consumed only by the approved build`() throws {
        let suiteName = "AppUpdateRestartTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        PendingAppUpdateRestart.record(expectedBuild: "2026072901", defaults: defaults)

        // A failed Sparkle install may relaunch the old app. It must leave the
        // marker intact and must not restart the gateway with stale payload.
        #expect(
            !PendingAppUpdateRestart.consumeIfCurrentBuild(
                defaults: defaults,
                currentBuild: "2026072390"))

        #expect(
            PendingAppUpdateRestart.consumeIfCurrentBuild(
                defaults: defaults,
                currentBuild: "2026072901"))

        // The new app gets one restart only. Later launches attach normally.
        #expect(
            !PendingAppUpdateRestart.consumeIfCurrentBuild(
                defaults: defaults,
                currentBuild: "2026072901"))
    }
}
