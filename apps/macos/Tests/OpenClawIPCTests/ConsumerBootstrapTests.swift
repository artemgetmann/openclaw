import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ConsumerBootstrapTests {
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

    @MainActor
    @Test func `telegram setup adds heartbeat delivery to paired dm`() {
        var root: [String: Any] = [
            "agents": [
                "defaults": [
                    "heartbeat": [
                        "target": "none",
                    ],
                ],
            ],
        ]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: [" 1336356696 "])

        #expect(changed)
        let heartbeat = ((root["agents"] as? [String: Any])?["defaults"] as? [String: Any])?["heartbeat"] as? [String: Any]
        #expect(heartbeat?["every"] as? String == "1d")
        #expect(heartbeat?["target"] as? String == "telegram")
        #expect(heartbeat?["to"] as? String == "1336356696")
        #expect(heartbeat?["accountId"] as? String == "default")
        #expect(heartbeat?["directPolicy"] as? String == "allow")
        let activeHours = heartbeat?["activeHours"] as? [String: Any]
        #expect(activeHours?["start"] as? String == "09:00")
        #expect(activeHours?["end"] as? String == "20:00")
        #expect(activeHours?["timezone"] as? String == "user")
    }

    @MainActor
    @Test func `telegram setup replaces stale heartbeat recipient when enabling target`() {
        var root: [String: Any] = [
            "agents": [
                "defaults": [
                    "heartbeat": [
                        "target": "none",
                        "to": "old-user-id",
                    ],
                ],
            ],
        ]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: ["new-user-id"])

        #expect(changed)
        let heartbeat = ((root["agents"] as? [String: Any])?["defaults"] as? [String: Any])?["heartbeat"] as? [String: Any]
        #expect(heartbeat?["target"] as? String == "telegram")
        #expect(heartbeat?["to"] as? String == "new-user-id")
        #expect(heartbeat?["directPolicy"] as? String == "allow")
    }

    @MainActor
    @Test func `telegram setup replaces stale heartbeat recipient on re-pair`() {
        var root: [String: Any] = [
            "agents": [
                "defaults": [
                    "heartbeat": [
                        "target": "telegram",
                        "to": "old-user-id",
                        "accountId": "old-account",
                        "directPolicy": "block",
                    ],
                ],
            ],
        ]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: ["new-user-id"],
            previousAllowFrom: ["old-user-id"])

        #expect(changed)
        let heartbeat = ((root["agents"] as? [String: Any])?["defaults"] as? [String: Any])?["heartbeat"] as? [String: Any]
        #expect(heartbeat?["target"] as? String == "telegram")
        #expect(heartbeat?["to"] as? String == "new-user-id")
        #expect(heartbeat?["accountId"] as? String == "default")
        #expect(heartbeat?["directPolicy"] as? String == "allow")
    }

    @MainActor
    @Test func `telegram setup preserves explicit telegram heartbeat route on re-pair`() {
        var root: [String: Any] = [
            "agents": [
                "defaults": [
                    "heartbeat": [
                        "every": "30m",
                        "target": "telegram",
                        "to": "-1001234567890:topic:42",
                        "accountId": "ops-bot",
                        "directPolicy": "block",
                    ],
                ],
            ],
        ]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: ["new-user-id"],
            previousAllowFrom: ["old-user-id"])

        #expect(changed)
        let heartbeat = ((root["agents"] as? [String: Any])?["defaults"] as? [String: Any])?["heartbeat"] as? [String: Any]
        #expect(heartbeat?["target"] as? String == "telegram")
        #expect(heartbeat?["to"] as? String == "-1001234567890:topic:42")
        #expect(heartbeat?["accountId"] as? String == "ops-bot")
        #expect(heartbeat?["directPolicy"] as? String == "block")
    }

    @MainActor
    @Test func `telegram setup preserves custom heartbeat routing`() {
        var root: [String: Any] = [
            "agents": [
                "defaults": [
                    "heartbeat": [
                        "every": "30m",
                        "target": "whatsapp",
                        "to": "+15551234567",
                        "accountId": "personal",
                    ],
                ],
            ],
        ]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: ["1336356696"])

        #expect(!changed)
        let heartbeat = ((root["agents"] as? [String: Any])?["defaults"] as? [String: Any])?["heartbeat"] as? [String: Any]
        #expect(heartbeat?["every"] as? String == "30m")
        #expect(heartbeat?["target"] as? String == "whatsapp")
        #expect(heartbeat?["to"] as? String == "+15551234567")
        #expect(heartbeat?["accountId"] as? String == "personal")
    }

    @MainActor
    @Test func `telegram setup waits for dm before heartbeat routing`() {
        var root: [String: Any] = [:]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: nil)

        #expect(!changed)
        #expect(root["agents"] == nil)
    }

    @MainActor
    @Test func `telegram setup disables stale setup owned heartbeat before dm`() {
        var root: [String: Any] = [
            "agents": [
                "defaults": [
                    "heartbeat": [
                        "target": "telegram",
                        "to": "old-user-id",
                        "accountId": "old-bot",
                        "directPolicy": "block",
                    ],
                ],
            ],
        ]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: nil,
            previousAllowFrom: ["old-user-id"])

        #expect(changed)
        let heartbeat = ((root["agents"] as? [String: Any])?["defaults"] as? [String: Any])?["heartbeat"] as? [String: Any]
        #expect(heartbeat?["target"] as? String == "none")
        #expect(heartbeat?["to"] == nil)
        #expect(heartbeat?["accountId"] == nil)
        #expect(heartbeat?["directPolicy"] == nil)
    }

    @MainActor
    @Test func `telegram setup preserves explicit telegram heartbeat route before dm`() {
        var root: [String: Any] = [
            "agents": [
                "defaults": [
                    "heartbeat": [
                        "target": "telegram",
                        "to": "-1001234567890:topic:42",
                        "accountId": "ops-bot",
                    ],
                ],
            ],
        ]

        let changed = ChannelsStore.configureConsumerTelegramHeartbeatDefaults(
            into: &root,
            allowFrom: nil,
            previousAllowFrom: ["old-user-id"])

        #expect(!changed)
        let heartbeat = ((root["agents"] as? [String: Any])?["defaults"] as? [String: Any])?["heartbeat"] as? [String: Any]
        #expect(heartbeat?["target"] as? String == "telegram")
        #expect(heartbeat?["to"] as? String == "-1001234567890:topic:42")
        #expect(heartbeat?["accountId"] as? String == "ops-bot")
    }
}
