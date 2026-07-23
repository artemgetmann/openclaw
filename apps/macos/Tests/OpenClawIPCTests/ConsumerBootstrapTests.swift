import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ConsumerBootstrapTests {
    @Test func `consumer defaults to signed in browser without overwriting explicit profile`() {
        var missingRoot: [String: Any] = [:]

        let filled = ConsumerBootstrap.applyMissingConfigDefaults(to: &missingRoot)

        #expect(filled)
        let browser = missingRoot["browser"] as? [String: Any]
        #expect(browser?["defaultProfile"] as? String == "signed-in")

        var customRoot: [String: Any] = [
            "browser": [
                "defaultProfile": "company-browser",
            ],
        ]

        _ = ConsumerBootstrap.applyMissingConfigDefaults(to: &customRoot)

        let customBrowser = customRoot["browser"] as? [String: Any]
        #expect(customBrowser?["defaultProfile"] as? String == "company-browser")
    }

    @Test func `consumer migrates app owned legacy browser profiles on launch`() {
        var root: [String: Any] = [
            "browser": [
                "defaultProfile": "user",
                "profiles": [
                    "openclaw": [
                        "cdpPort": 18_800,
                        "color": "#FF4500",
                    ],
                    "user": [
                        "cdpPort": 18_801,
                        "driver": "openclaw",
                        "cloneFromUserProfile": true,
                        "sourceChromeDir": "/Applications/Chrome Beta",
                        "sourceProfileName": "Profile 4",
                        "color": "#00AA00",
                    ],
                ],
            ],
        ]

        let changed = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

        #expect(changed)
        let browser = root["browser"] as? [String: Any]
        #expect(browser?["defaultProfile"] as? String == "signed-in")
        let profiles = browser?["profiles"] as? [String: Any]
        #expect(profiles?["openclaw"] == nil)
        #expect(profiles?["user"] == nil)
        let signedIn = profiles?["signed-in"] as? [String: Any]
        #expect(signedIn?["cdpPort"] as? Int == 18_801)
        #expect(signedIn?["driver"] as? String == "existing-session")
        #expect(signedIn?["cloneFromUserProfile"] as? Bool == true)
        #expect(signedIn?["sourceChromeDir"] as? String == "/Applications/Chrome Beta")
        #expect(signedIn?["sourceProfileName"] as? String == "Profile 4")
        #expect(signedIn?["profileDirectory"] as? String == "Default")
        #expect(signedIn?["color"] as? String == "#1F9D55")
    }

    @Test func `consumer retires isolated default without deleting custom profile config`() {
        var root: [String: Any] = [
            "browser": [
                "defaultProfile": "openclaw",
                "profiles": [
                    "openclaw": [
                        "cdpUrl": "http://127.0.0.1:9333",
                        "color": "#123456",
                    ],
                ],
            ],
        ]

        _ = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

        let browser = root["browser"] as? [String: Any]
        #expect(browser?["defaultProfile"] as? String == "signed-in")
        let profiles = browser?["profiles"] as? [String: Any]
        let preserved = profiles?["openclaw"] as? [String: Any]
        #expect(preserved?["cdpUrl"] as? String == "http://127.0.0.1:9333")
        #expect(preserved?["color"] as? String == "#123456")
    }

    @Test func `consumer preserves schema valid custom profile named user`() {
        var root: [String: Any] = [
            "browser": [
                "defaultProfile": "user",
                "profiles": [
                    "user": [
                        "cdpPort": 19_901,
                        "driver": "existing-session",
                        "cloneFromUserProfile": true,
                        "sourceProfileName": "Profile 9",
                        "profileDirectory": "Default",
                        "color": "#0066CC",
                    ],
                ],
            ],
        ]

        _ = ConsumerBootstrap.applyMissingConfigDefaults(to: &root)

        let browser = root["browser"] as? [String: Any]
        #expect(browser?["defaultProfile"] as? String == "user")
        let profiles = browser?["profiles"] as? [String: Any]
        let preserved = profiles?["user"] as? [String: Any]
        #expect(preserved?["sourceProfileName"] as? String == "Profile 9")
        #expect(preserved?["color"] as? String == "#0066CC")
    }

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
