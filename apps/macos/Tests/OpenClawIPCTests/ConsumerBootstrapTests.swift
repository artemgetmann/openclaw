import Foundation
import Testing
@testable import OpenClaw

struct ConsumerBootstrapTests {
    @Test func `consumer bootstrap fills in missing isolated defaults`() async {
        await TestIsolation.withIsolatedState(env: [ConsumerInstance.envKey: nil]) {
            var root: [String: Any] = [:]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let gateway = root["gateway"] as? [String: Any]
            let agents = root["agents"] as? [String: Any]
            let agentDefaults = agents?["defaults"] as? [String: Any]
            let modelDefaults = agentDefaults?["model"] as? [String: Any]
            let allowlistedModels = agentDefaults?["models"] as? [String: Any]
            let consumerModel = allowlistedModels?["openai-codex/gpt-5.4"] as? [String: Any]
            let skills = root["skills"] as? [String: Any]
            let install = skills?["install"] as? [String: Any]
            let discovery = root["discovery"] as? [String: Any]
            let mdns = discovery?["mdns"] as? [String: Any]

            #expect(changed)
            #expect(gateway?["mode"] as? String == "local")
            #expect(gateway?["port"] as? Int == ConsumerRuntime.gatewayPort)
            #expect(gateway?["bind"] as? String == ConsumerRuntime.gatewayBind)
            #expect(agentDefaults?["workspace"] as? String == ConsumerRuntime.workspaceURL.path)
            #expect(modelDefaults?["primary"] as? String == "openai-codex/gpt-5.4")
            #expect(consumerModel?["alias"] as? String == "GPT")
            #expect(install?["nodeManager"] as? String == "npm")
            #expect(skills?["allowBundled"] as? [String] == [
                "consumer-setup",
                "apple-notes",
                "apple-reminders",
                "bear-notes",
                "camsnap",
                "canvas",
                "gog",
                "goplaces",
                "himalaya",
                "peekaboo",
                "summarize",
                "weather",
            ])
            #expect(mdns?["mode"] as? String == "off")
        }
    }

    @Test func `consumer bootstrap preserves existing user choices`() async {
        await TestIsolation.withIsolatedState(env: [ConsumerInstance.envKey: nil]) {
            var root: [String: Any] = [
                "gateway": [
                    "mode": "remote",
                    "port": 28888,
                    "bind": "tailnet",
                ],
                "agents": [
                    "defaults": [
                        "model": [
                            "primary": "anthropic/claude-opus-4-6",
                        ],
                    ],
                ],
                "discovery": [
                    "mdns": [
                        "mode": "full",
                    ],
                ],
            ]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let gateway = root["gateway"] as? [String: Any]
            let agents = root["agents"] as? [String: Any]
            let agentDefaults = agents?["defaults"] as? [String: Any]
            let modelDefaults = agentDefaults?["model"] as? [String: Any]
            let discovery = root["discovery"] as? [String: Any]
            let mdns = discovery?["mdns"] as? [String: Any]

            #expect(changed)
            #expect(gateway?["mode"] as? String == "remote")
            #expect(gateway?["port"] as? Int == 28888)
            #expect(gateway?["bind"] as? String == "tailnet")
            #expect(modelDefaults?["primary"] as? String == "anthropic/claude-opus-4-6")
            #expect(mdns?["mode"] as? String == "full")
        }
    }

    @Test func `named consumer instance seeds instance specific workspace and port`() async {
        await TestIsolation.withEnvValues([ConsumerInstance.envKey: "smoke-1"]) {
            var root: [String: Any] = [:]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)
            let gateway = root["gateway"] as? [String: Any]
            let agents = root["agents"] as? [String: Any]
            let agentDefaults = agents?["defaults"] as? [String: Any]

            #expect(changed)
            #expect(gateway?["port"] as? Int == ConsumerRuntime.gatewayPort)
            #expect(agentDefaults?["workspace"] as? String == ConsumerRuntime.workspaceURL.path)
            #expect((agentDefaults?["workspace"] as? String)?.contains("/instances/smoke-1/.openclaw/workspace") == true)
        }
    }
}
