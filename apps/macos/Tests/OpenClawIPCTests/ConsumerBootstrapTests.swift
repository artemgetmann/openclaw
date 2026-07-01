import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ConsumerBootstrapTests {
    @Test func `consumer defaults enable Telegram inbound debounce without overwriting explicit opt out`() {
        var missingRoot: [String: Any] = [
            "messages": [
                "ackReactionScope": "group-mentions",
            ],
            "channels": [
                "telegram": [
                    "streaming": "partial",
                ],
            ],
        ]

        let filled = ConsumerBootstrap.applyMissingConfigDefaults(to: &missingRoot)

        #expect(filled)
        let messages = missingRoot["messages"] as? [String: Any]
        let inbound = messages?["inbound"] as? [String: Any]
        let byChannel = inbound?["byChannel"] as? [String: Any]
        #expect(byChannel?["telegram"] as? Int == 1000)

        var optedOutRoot: [String: Any] = [
            "messages": [
                "inbound": [
                    "byChannel": [
                        "telegram": 0,
                    ],
                ],
            ],
        ]

        let preserved = ConsumerBootstrap.applyMissingConfigDefaults(to: &optedOutRoot)

        #expect(preserved)
        let optedOutMessages = optedOutRoot["messages"] as? [String: Any]
        let optedOutInbound = optedOutMessages?["inbound"] as? [String: Any]
        let optedOutByChannel = optedOutInbound?["byChannel"] as? [String: Any]
        #expect(optedOutByChannel?["telegram"] as? Int == 0)
    }

    @Test func `seeded defaults add backend activation config without overwriting user config`() {
        var root: [String: Any] = [
            "jarvis": [
                "backend": [
                    "baseUrl": "https://custom.jarvis.example",
                ],
            ],
        ]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(
            to: &root,
            seededDefaults: [
                "jarvis": [
                    "backend": [
                        "baseUrl": "https://seeded.jarvis.example",
                        "accessToken": "backend-bearer-value",
                    ],
                    "managedServices": [
                        "mode": "managed",
                    ],
                ],
            ])

        #expect(changed)
        let jarvis = root["jarvis"] as? [String: Any]
        let backend = jarvis?["backend"] as? [String: Any]
        #expect(backend?["baseUrl"] as? String == "https://custom.jarvis.example")
        #expect(backend?["accessToken"] as? String == "backend-bearer-value")
        let managedServices = jarvis?["managedServices"] as? [String: Any]
        #expect(managedServices?["mode"] as? String == "managed")
    }

    @Test func `seeded defaults refresh stale packaged backend token`() {
        var root: [String: Any] = [
            "jarvis": [
                "backend": [
                    "baseUrl": "https://jarvis-backend-klvq.onrender.com",
                    "accessToken": "stale-backend-token",
                ],
            ],
        ]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(
            to: &root,
            seededDefaults: [
                "jarvis": [
                    "backend": [
                        "baseUrl": "https://jarvis-backend-klvq.onrender.com",
                        "accessToken": "fresh-backend-token",
                    ],
                ],
            ])

        #expect(changed)
        let backend = (root["jarvis"] as? [String: Any])?["backend"] as? [String: Any]
        #expect(backend?["accessToken"] as? String == "fresh-backend-token")
    }

    @Test func `seeded defaults preserve custom backend token`() {
        var root: [String: Any] = [
            "jarvis": [
                "backend": [
                    "baseUrl": "https://custom.jarvis.example",
                    "accessToken": "custom-backend-token",
                ],
            ],
        ]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(
            to: &root,
            seededDefaults: [
                "jarvis": [
                    "backend": [
                        "baseUrl": "https://jarvis-backend-klvq.onrender.com",
                        "accessToken": "fresh-backend-token",
                    ],
                ],
            ])

        #expect(changed)
        let backend = (root["jarvis"] as? [String: Any])?["backend"] as? [String: Any]
        #expect(backend?["baseUrl"] as? String == "https://custom.jarvis.example")
        #expect(backend?["accessToken"] as? String == "custom-backend-token")
    }
}
