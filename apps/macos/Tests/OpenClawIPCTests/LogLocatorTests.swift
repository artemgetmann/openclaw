import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct LogLocatorTests {
    @Test func `launchd gateway log path ensures tmp dir exists`() async {
        let fm = FileManager()
        let baseDir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let logDir = baseDir.appendingPathComponent("openclaw-tests-\(UUID().uuidString)")

        defer {
            unsetenv("OPENCLAW_LOG_DIR")
            try? fm.removeItem(at: logDir)
        }

        await TestIsolation.withEnvValues(["OPENCLAW_LOG_DIR": logDir.path]) {
            _ = LogLocator.launchdGatewayLogPath
        }

        var isDir: ObjCBool = false
        #expect(fm.fileExists(atPath: logDir.path, isDirectory: &isDir))
        #expect(isDir.boolValue == true)
    }
}
