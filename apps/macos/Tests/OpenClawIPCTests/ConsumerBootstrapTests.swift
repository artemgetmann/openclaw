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
            let codex53 = allowlistedModels?["openai-codex/gpt-5.3-codex"] as? [String: Any]
            let sonnet = allowlistedModels?["anthropic/claude-sonnet-4-6"] as? [String: Any]
            let opus = allowlistedModels?["anthropic/claude-opus-4-6"] as? [String: Any]
            let haiku = allowlistedModels?["anthropic/claude-haiku-4-5"] as? [String: Any]
            let skills = root["skills"] as? [String: Any]
            let install = skills?["install"] as? [String: Any]
            let env = root["env"] as? [String: Any]
            let shellEnv = env?["shellEnv"] as? [String: Any]
            let discovery = root["discovery"] as? [String: Any]
            let mdns = discovery?["mdns"] as? [String: Any]

            #expect(changed)
            #expect(gateway?["mode"] as? String == "local")
            #expect(gateway?["port"] as? Int == ConsumerRuntime.gatewayPort)
            #expect(gateway?["bind"] as? String == ConsumerRuntime.gatewayBind)
            #expect(agentDefaults?["workspace"] as? String == ConsumerRuntime.workspaceURL.path)
            #expect(modelDefaults?["primary"] as? String == "openai-codex/gpt-5.4")
            #expect(agentDefaults?["thinkingDefault"] as? String == "adaptive")
            #expect(consumerModel?["alias"] as? String == "GPT")
            #expect(codex53?["alias"] as? String == "Codex 5.3")
            #expect(sonnet?["alias"] as? String == "Sonnet")
            #expect(opus?["alias"] as? String == "Opus")
            #expect(haiku?["alias"] as? String == "Haiku")
            #expect(shellEnv?["enabled"] as? Bool == true)
            #expect(install?["nodeManager"] as? String == "npm")
            #expect(skills?["allowBundled"] as? [String] == [
                "consumer-setup",
                "apple-notes",
                "apple-reminders",
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

    @Test func `consumer bootstrap seeds first launch location defaults`() async {
        let fm = FileManager()
        let tempHome = fm.temporaryDirectory
            .appendingPathComponent("openclaw-consumer-bootstrap-\(UUID().uuidString)", isDirectory: true)
        try? fm.createDirectory(at: tempHome, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tempHome) }

        await TestIsolation.withIsolatedState(
            env: [ConsumerInstance.envKey: nil, "HOME": tempHome.path],
            defaults: [
                locationModeKey: nil,
                locationPreciseKey: nil,
            ]) {
            ConsumerBootstrap.bootstrapIfNeeded()

            #expect(
                UserDefaults.standard.string(forKey: locationModeKey)
                    == "whileUsing")
            #expect(UserDefaults.standard.bool(forKey: locationPreciseKey))
        }
    }

    @Test func `consumer bootstrap imports legacy web defaults when founder config already has them`() async {
        let fm = FileManager()
        let tempHome = fm.temporaryDirectory
            .appendingPathComponent("openclaw-consumer-web-\(UUID().uuidString)", isDirectory: true)
        let legacyConfigDir = tempHome.appendingPathComponent(".openclaw", isDirectory: true)
        let legacyConfigPath = legacyConfigDir.appendingPathComponent("openclaw.json")
        try? fm.createDirectory(at: legacyConfigDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tempHome) }

        let sourceRoot: [String: Any] = [
            "tools": [
                "web": [
                    "search": [
                        "provider": "brave",
                        "enabled": true,
                        "apiKey": "brave-test-key", // pragma: allowlist secret
                    ],
                    "fetch": [
                        "enabled": true,
                        "firecrawl": [
                            "enabled": true,
                            "apiKey": "firecrawl-test-key", // pragma: allowlist secret
                        ],
                    ],
                ],
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: sourceRoot, options: [.prettyPrinted, .sortedKeys])
        try! data.write(to: legacyConfigPath)

        await TestIsolation.withIsolatedState(
            env: [ConsumerInstance.envKey: nil, "HOME": tempHome.path],
            defaults: [:]) {
            var root: [String: Any] = [:]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let tools = root["tools"] as? [String: Any]
            let web = tools?["web"] as? [String: Any]
            let search = web?["search"] as? [String: Any]
            let fetch = web?["fetch"] as? [String: Any]
            let firecrawl = fetch?["firecrawl"] as? [String: Any]

            #expect(changed)
            #expect(search?["provider"] as? String == "brave")
            #expect(search?["enabled"] as? Bool == true)
            #expect(search?["apiKey"] as? String == "brave-test-key")
            #expect(fetch?["enabled"] as? Bool == true)
            #expect(firecrawl?["enabled"] as? Bool == true)
            #expect(firecrawl?["apiKey"] as? String == "firecrawl-test-key")
        }
    }

    @Test func `consumer bootstrap merges bundled defaults without overwriting user choices`() async {
        var root: [String: Any] = [
            "tools": [
                "web": [
                    "search": [
                        "enabled": true,
                    ],
                ],
            ],
        ]
        let bundledDefaults: [String: Any] = [
            "env": [
                "vars": [
                    "FIRECRAWL_API_KEY": "fc-seeded", // pragma: allowlist secret
                    "GOOGLE_PLACES_API_KEY": "places-seeded", // pragma: allowlist secret
                ],
            ],
            "skills": [
                "entries": [
                    "goplaces": [
                        "apiKey": "places-seeded", // pragma: allowlist secret
                    ],
                ],
            ],
            "tools": [
                "web": [
                    "search": [
                        "enabled": false,
                        "provider": "firecrawl",
                    ],
                    "fetch": [
                        "enabled": true,
                        "firecrawl": [
                            "enabled": true,
                        ],
                    ],
                ],
            ],
        ]

        let changed = ConsumerBootstrap.seedBundledDefaultsIfMissing(
            into: &root,
            bundledDefaults: bundledDefaults)

        let env = root["env"] as? [String: Any]
        let vars = env?["vars"] as? [String: Any]
        let skills = root["skills"] as? [String: Any]
        let entries = skills?["entries"] as? [String: Any]
        let goplaces = entries?["goplaces"] as? [String: Any]
        let tools = root["tools"] as? [String: Any]
        let web = tools?["web"] as? [String: Any]
        let search = web?["search"] as? [String: Any]
        let fetch = web?["fetch"] as? [String: Any]
        let firecrawl = fetch?["firecrawl"] as? [String: Any]

        #expect(changed)
        #expect(vars?["FIRECRAWL_API_KEY"] as? String == "fc-seeded")
        #expect(vars?["GOOGLE_PLACES_API_KEY"] as? String == "places-seeded")
        #expect(goplaces?["apiKey"] as? String == "places-seeded")
        #expect(search?["enabled"] as? Bool == true)
        #expect(search?["provider"] as? String == "firecrawl")
        #expect(fetch?["enabled"] as? Bool == true)
        #expect(firecrawl?["enabled"] as? Bool == true)
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
