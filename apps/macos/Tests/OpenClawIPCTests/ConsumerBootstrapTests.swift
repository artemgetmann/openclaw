import Foundation
import Testing
@testable import OpenClaw

struct ConsumerBootstrapTests {
    @Test func `consumer bootstrap fills in missing isolated defaults`() {
        var root: [String: Any] = [:]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

        let gateway = root["gateway"] as? [String: Any]
        let agents = root["agents"] as? [String: Any]
        let agentDefaults = agents?["defaults"] as? [String: Any]
        let skills = root["skills"] as? [String: Any]
        let install = skills?["install"] as? [String: Any]
        let discovery = root["discovery"] as? [String: Any]
        let mdns = discovery?["mdns"] as? [String: Any]

        #expect(changed)
        #expect(gateway?["mode"] as? String == "local")
        #expect(gateway?["port"] as? Int == ConsumerRuntime.gatewayPort)
        #expect(gateway?["bind"] as? String == ConsumerRuntime.gatewayBind)
        #expect(agentDefaults?["workspace"] as? String == ConsumerRuntime.workspaceURL.path)
        #expect(install?["nodeManager"] as? String == "npm")
        #expect(skills?["allowBundled"] as? [String] == [
            "apple-notes",
            "apple-reminders",
            "bear-notes",
            "camsnap",
            "canvas",
            "goplaces",
            "peekaboo",
            "summarize",
            "weather",
        ])
        #expect(mdns?["mode"] as? String == "off")
    }

    @Test func `consumer bootstrap preserves existing user choices`() {
        var root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "port": 28888,
                "bind": "tailnet",
            ],
            "discovery": [
                "mdns": [
                    "mode": "full",
                ],
            ],
        ]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

        let gateway = root["gateway"] as? [String: Any]
        let discovery = root["discovery"] as? [String: Any]
        let mdns = discovery?["mdns"] as? [String: Any]

        #expect(changed)
        #expect(gateway?["mode"] as? String == "remote")
        #expect(gateway?["port"] as? Int == 28888)
        #expect(gateway?["bind"] as? String == "tailnet")
        #expect(mdns?["mode"] as? String == "full")
    }
}
