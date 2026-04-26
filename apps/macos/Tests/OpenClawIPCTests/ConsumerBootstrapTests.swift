import Foundation
import Testing
@testable import OpenClaw

struct ConsumerBootstrapTests {
    @Test func `consumer bootstrap fills in missing isolated defaults`() async {
        await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: nil,
                "OPENCLAW_SERVICE_PATH_PREFIX": "",
            ]) {
            var root: [String: Any] = [:]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let gateway = root["gateway"] as? [String: Any]
            let tools = root["tools"] as? [String: Any]
            let exec = tools?["exec"] as? [String: Any]
            let trustedDirs = exec?["safeBinTrustedDirs"] as? [String]
            let safeBinProfiles = exec?["safeBinProfiles"] as? [String: Any]
            let wacliProfile = safeBinProfiles?["wacli"] as? [String: Any]
            let wacliAuthLocalProfile = safeBinProfiles?["wacli-auth-local.sh"] as? [String: Any]
            let agents = root["agents"] as? [String: Any]
            let agentDefaults = agents?["defaults"] as? [String: Any]
            let modelDefaults = agentDefaults?["model"] as? [String: Any]
            let allowlistedModels = agentDefaults?["models"] as? [String: Any]
            let consumerModel = allowlistedModels?["openai-codex/gpt-5.5"] as? [String: Any]
            let codex54 = allowlistedModels?["openai-codex/gpt-5.4"] as? [String: Any]
            let codex54Mini = allowlistedModels?["openai-codex/gpt-5.4-mini"] as? [String: Any]
            let codexSpark = allowlistedModels?["openai-codex/gpt-5.3-codex-spark"] as? [String: Any]
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
            #expect(exec?["host"] as? String == "gateway")
            #expect(exec?["safeBins"] as? [String] == ["gog", "himalaya", "wacli", "wacli-auth-local.sh"])
            #expect(trustedDirs == [])
            #expect(wacliProfile?["maxPositional"] as? Int == 3)
            #expect(
                wacliProfile?["allowedValueFlags"] as? [String] == [
                    "--limit",
                    "--query",
                    "--after",
                    "--before",
                    "--chat",
                    "--once",
                    "--idle-exit",
                    "--refresh-contacts",
                    "--refresh-groups",
                ])
            #expect(wacliProfile?["deniedFlags"] as? [String] == ["--follow"])
            #expect(wacliAuthLocalProfile?["maxPositional"] as? Int == 1)
            #expect(
                wacliAuthLocalProfile?["allowedValueFlags"] as? [String] == [
                    "--session",
                    "--wait-ms",
                    "--idle-exit",
                    "--timeout-ms",
                ])
            #expect(agentDefaults?["workspace"] as? String == ConsumerRuntime.workspaceURL.path)
            #expect(modelDefaults?["primary"] as? String == "openai-codex/gpt-5.5")
            #expect(agentDefaults?["thinkingDefault"] as? String == "adaptive")
            #expect(consumerModel?["alias"] as? String == "GPT")
            #expect(codex54?["alias"] as? String == "GPT 5.4")
            #expect(codex54Mini?["alias"] as? String == "GPT 5.4 Mini")
            #expect(codexSpark?["alias"] as? String == "GPT 5.3 Codex Spark")
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
                "wacli",
                "telegram-user",
                "nano-banana-pro",
                "peekaboo",
                "summarize",
                "weather",
            ])
            #expect(mdns?["mode"] as? String == "off")
        }
    }

    @Test func `consumer bootstrap trusts the cleanroom helper dir when present`() async {
        await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: "user-e2e-20260402",
                "OPENCLAW_SERVICE_PATH_PREFIX": "/tmp/openclaw-consumer-cleanroom/user-e2e-20260402/bin",
            ]) {
            var root: [String: Any] = [:]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let exec = (root["tools"] as? [String: Any])?["exec"] as? [String: Any]
            let trustedDirs = exec?["safeBinTrustedDirs"] as? [String]

            #expect(changed)
            #expect(trustedDirs == [
                "/tmp/openclaw-consumer-cleanroom/user-e2e-20260402/bin",
            ])
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
                        "brave": [
                            "apiKey": "brave-test-key", // pragma: allowlist secret
                            "mode": "llm-context",
                        ],
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
            let brave = search?["brave"] as? [String: Any]
            #expect(brave?["mode"] as? String == "llm-context")
            #expect(brave?["apiKey"] == nil)
            #expect(fetch?["enabled"] as? Bool == true)
            #expect(firecrawl?["enabled"] as? Bool == true)
            #expect(firecrawl?["apiKey"] as? String == "firecrawl-test-key")
        }
    }

    @Test func `consumer bootstrap migrates existing legacy Brave search keys in place`() async {
        await TestIsolation.withIsolatedState(env: [ConsumerInstance.envKey: nil]) {
            var root: [String: Any] = [
                "tools": [
                    "web": [
                        "search": [
                            "enabled": true,
                            "provider": "brave",
                            "brave": [
                                "apiKey": "legacy-brave-key", // pragma: allowlist secret
                                "mode": "web",
                            ],
                        ],
                    ],
                ],
            ]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)
            let tools = root["tools"] as? [String: Any]
            let web = tools?["web"] as? [String: Any]
            let search = web?["search"] as? [String: Any]
            let brave = search?["brave"] as? [String: Any]

            #expect(changed)
            #expect(search?["apiKey"] as? String == "legacy-brave-key")
            #expect(brave?["mode"] as? String == "web")
            #expect(brave?["apiKey"] == nil)
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
                        "OPENCLAW_CONSUMER_OPENAI_API_KEY": "openai-seeded", // pragma: allowlist secret
                        "OPENCLAW_CONSUMER_GEMINI_API_KEY": "gemini-seeded", // pragma: allowlist secret
                        "GEMINI_API_KEY": "gemini-seeded", // pragma: allowlist secret
                        "FIRECRAWL_API_KEY": "fc-seeded", // pragma: allowlist secret
                        "GOOGLE_PLACES_API_KEY": "places-seeded", // pragma: allowlist secret
                    ],
                ],
                "plugins": [
                "entries": [:],
            ],
                "skills": [
                    "entries": [
                        "goplaces": [
                            "apiKey": "places-seeded", // pragma: allowlist secret
                        ],
                        "nano-banana-pro": [
                            "apiKey": "gemini-seeded", // pragma: allowlist secret
                        ],
                    ],
                ],
                "tools": [
                "media": [
                    "audio": [
                        "models": [[
                            "provider": "openai",
                            "model": "gpt-4o-mini-transcribe",
                            "apiKey": "${OPENCLAW_CONSUMER_OPENAI_API_KEY}",
                        ]],
                    ],
                ],
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
        let nanoBanana = entries?["nano-banana-pro"] as? [String: Any]
        let goplaces = entries?["goplaces"] as? [String: Any]
        let tools = root["tools"] as? [String: Any]
        let media = tools?["media"] as? [String: Any]
        let audio = media?["audio"] as? [String: Any]
        let audioModels = audio?["models"] as? [[String: Any]]
        let web = tools?["web"] as? [String: Any]
        let search = web?["search"] as? [String: Any]
        let fetch = web?["fetch"] as? [String: Any]
        let firecrawl = fetch?["firecrawl"] as? [String: Any]

        #expect(changed)
        #expect(vars?["OPENCLAW_CONSUMER_OPENAI_API_KEY"] as? String == "openai-seeded")
        #expect(vars?["OPENCLAW_CONSUMER_GEMINI_API_KEY"] as? String == "gemini-seeded")
        #expect(vars?["GEMINI_API_KEY"] as? String == "gemini-seeded")
        #expect(vars?["OPENAI_API_KEY"] == nil)
        #expect(vars?["FIRECRAWL_API_KEY"] as? String == "fc-seeded")
        #expect(vars?["GOOGLE_PLACES_API_KEY"] as? String == "places-seeded")
        #expect(goplaces?["apiKey"] as? String == "places-seeded")
        #expect(nanoBanana?["apiKey"] as? String == "gemini-seeded")
        #expect(audioModels?.count == 1)
        #expect(audioModels?.first?["provider"] as? String == "openai")
        #expect(audioModels?.first?["model"] as? String == "gpt-4o-mini-transcribe")
        #expect(audioModels?.first?["apiKey"] as? String == "${OPENCLAW_CONSUMER_OPENAI_API_KEY}")
        #expect(search?["enabled"] as? Bool == true)
        #expect(search?["provider"] as? String == "firecrawl")
        #expect(fetch?["enabled"] as? Bool == true)
        #expect(firecrawl?["enabled"] as? Bool == true)
    }

    @Test func `consumer bootstrap keeps audio enabled without seeding a broken speech model when key is absent`() async {
        var root: [String: Any] = [:]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

        let tools = root["tools"] as? [String: Any]
        let media = tools?["media"] as? [String: Any]
        let audio = media?["audio"] as? [String: Any]

        #expect(changed)
        #expect(audio?["enabled"] as? Bool == true)
        #expect(audio?["models"] == nil)
    }

    @Test func `consumer bootstrap seeds native image generation when consumer OpenAI key exists`() async {
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONSUMER_OPENAI_API_KEY": "consumer-openai-seeded", // pragma: allowlist secret
                ConsumerInstance.envKey: nil,
            ]) {
            var root: [String: Any] = [:]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let agents = root["agents"] as? [String: Any]
            let defaults = agents?["defaults"] as? [String: Any]
            let imageGenerationModel = defaults?["imageGenerationModel"] as? [String: Any]

            #expect(changed)
            #expect(imageGenerationModel?["primary"] as? String == "openai/gpt-image-2")
        }
    }

    @Test func `consumer bootstrap preserves existing native image generation choice`() async {
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONSUMER_OPENAI_API_KEY": "consumer-openai-seeded", // pragma: allowlist secret
                ConsumerInstance.envKey: nil,
            ]) {
            var root: [String: Any] = [
                "agents": [
                    "defaults": [
                        "imageGenerationModel": [
                            "primary": "custom/image-model",
                        ],
                    ],
                ],
            ]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let agents = root["agents"] as? [String: Any]
            let defaults = agents?["defaults"] as? [String: Any]
            let imageGenerationModel = defaults?["imageGenerationModel"] as? [String: Any]

            #expect(changed)
            #expect(imageGenerationModel?["primary"] as? String == "custom/image-model")
        }
    }

    @Test func `consumer bootstrap preserves existing user choices`() async {
        await TestIsolation.withIsolatedState(
            env: [
                ConsumerInstance.envKey: nil,
                "OPENCLAW_SERVICE_PATH_PREFIX": "",
            ]) {
            var root: [String: Any] = [
                "gateway": [
                    "mode": "remote",
                    "port": 28888,
                    "bind": "tailnet",
                ],
                "tools": [
                    "exec": [
                        "host": "node",
                        "safeBins": ["custom-cli"],
                        "safeBinTrustedDirs": ["/tmp/openclaw-consumer-cleanroom/custom/bin"],
                        "safeBinProfiles": [
                            "custom-cli": [
                                "maxPositional": 0,
                            ],
                        ],
                    ],
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
            let tools = root["tools"] as? [String: Any]
            let exec = tools?["exec"] as? [String: Any]
            let safeBinProfiles = exec?["safeBinProfiles"] as? [String: Any]
            let agents = root["agents"] as? [String: Any]
            let agentDefaults = agents?["defaults"] as? [String: Any]
            let modelDefaults = agentDefaults?["model"] as? [String: Any]
            let discovery = root["discovery"] as? [String: Any]
            let mdns = discovery?["mdns"] as? [String: Any]

            #expect(changed)
            #expect(gateway?["mode"] as? String == "remote")
            #expect(gateway?["port"] as? Int == 28888)
            #expect(gateway?["bind"] as? String == "tailnet")
            #expect(exec?["host"] as? String == "node")
            #expect(
                exec?["safeBins"] as? [String] == [
                    "custom-cli",
                    "gog",
                    "himalaya",
                    "wacli",
                    "wacli-auth-local.sh",
                ])
            #expect(
                exec?["safeBinTrustedDirs"] as? [String] == [
                    "/tmp/openclaw-consumer-cleanroom/custom/bin",
                ])
            let customProfile = safeBinProfiles?["custom-cli"] as? [String: Any]
            let wacliProfile = safeBinProfiles?["wacli"] as? [String: Any]
            let wacliAuthLocalProfile = safeBinProfiles?["wacli-auth-local.sh"] as? [String: Any]
            #expect(customProfile?["maxPositional"] as? Int == 0)
            #expect(wacliProfile?["maxPositional"] as? Int == 3)
            #expect(
                wacliProfile?["allowedValueFlags"] as? [String] == [
                    "--limit",
                    "--query",
                    "--after",
                    "--before",
                    "--chat",
                    "--once",
                    "--idle-exit",
                    "--refresh-contacts",
                    "--refresh-groups",
                ])
            #expect(wacliProfile?["deniedFlags"] as? [String] == ["--follow"])
            #expect(wacliAuthLocalProfile?["maxPositional"] as? Int == 1)
            #expect(modelDefaults?["primary"] as? String == "anthropic/claude-opus-4-6")
            #expect(mdns?["mode"] as? String == "full")
        }
    }

    @Test func `consumer bootstrap appends missing bundled skills to existing allowlist`() async {
        await TestIsolation.withIsolatedState(env: [ConsumerInstance.envKey: nil]) {
            var root: [String: Any] = [
                "skills": [
                    "allowBundled": [
                        "consumer-setup",
                        "gog",
                    ],
                ],
            ]

            let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

            let skills = root["skills"] as? [String: Any]
            let allowBundled = skills?["allowBundled"] as? [String]

            #expect(changed)
            #expect(allowBundled?.contains("consumer-setup") == true)
            #expect(allowBundled?.contains("gog") == true)
            #expect(allowBundled?.contains("wacli") == true)
            #expect(allowBundled?.contains("telegram-user") == true)
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

    @Test func `consumer bootstrap migrates legacy brave search api key shape`() async {
        var root: [String: Any] = [
            "tools": [
                "web": [
                    "search": [
                        "provider": "brave",
                        "enabled": true,
                        "brave": [
                            "apiKey": "legacy-brave-key", // pragma: allowlist secret
                        ],
                    ],
                ],
            ],
        ]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

        let tools = root["tools"] as? [String: Any]
        let web = tools?["web"] as? [String: Any]
        let search = web?["search"] as? [String: Any]

        #expect(changed)
        #expect(search?["apiKey"] as? String == "legacy-brave-key")
        #expect(search?["brave"] == nil)
    }
}
