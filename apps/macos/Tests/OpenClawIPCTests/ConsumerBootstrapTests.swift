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
}
