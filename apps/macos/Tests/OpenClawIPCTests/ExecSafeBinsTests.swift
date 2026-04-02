import Foundation
import Testing
@testable import OpenClaw

struct ExecSafeBinsTests {
    @Test func `resolve policy trusts service prefix and state dir bins`() {
        let root: [String: Any] = [
            "tools": [
                "exec": [
                    "safeBins": ["wacli"],
                    "safeBinProfiles": [
                        "wacli": [
                            "maxPositional": 1,
                        ],
                    ],
                ],
            ],
        ]
        let env = [
            "OPENCLAW_SERVICE_PATH_PREFIX": "/tmp/openclaw-cleanroom/bin:/tmp/openclaw-cleanroom/tools",
            "OPENCLAW_STATE_DIR": "/tmp/openclaw-state",
        ]

        let policy = ExecSafeBins._testResolvePolicy(root: root, env: env)
        #expect(policy.safeBins.contains("wacli"))
        #expect(policy.trustedDirs.contains("/tmp/openclaw-cleanroom/bin"))
        #expect(policy.trustedDirs.contains("/tmp/openclaw-state/bin"))
        #expect(policy.trustedDirs.contains("/tmp/openclaw-state/tools/node/bin"))
    }

    @Test func `allows lane local wacli doctor via safe bin profile`() {
        let policy = ExecSafeBinPolicy(
            safeBins: Set(["wacli"]),
            profilesByName: [
                "wacli": ExecSafeBinProfile(
                    minPositional: nil,
                    maxPositional: 1,
                    allowedValueFlags: Set(),
                    deniedFlags: Set()),
            ],
            trustedDirs: Set(["/tmp/openclaw-cleanroom/bin"]))
        let resolution = ExecCommandResolution(
            rawExecutable: "wacli",
            resolvedPath: "/tmp/openclaw-cleanroom/bin/wacli",
            executableName: "wacli",
            cwd: nil)

        #expect(
            ExecSafeBins._testIsAllowed(
                command: ["wacli", "doctor"],
                resolution: resolution,
                policy: policy))
    }

    @Test func `rejects same basename outside trusted cleanroom`() {
        let policy = ExecSafeBinPolicy(
            safeBins: Set(["wacli"]),
            profilesByName: [
                "wacli": ExecSafeBinProfile(
                    minPositional: nil,
                    maxPositional: 1,
                    allowedValueFlags: Set(),
                    deniedFlags: Set()),
            ],
            trustedDirs: Set(["/tmp/openclaw-cleanroom/bin"]))
        let resolution = ExecCommandResolution(
            rawExecutable: "wacli",
            resolvedPath: "/opt/homebrew/bin/wacli",
            executableName: "wacli",
            cwd: nil)

        #expect(
            !ExecSafeBins._testIsAllowed(
                command: ["wacli", "doctor"],
                resolution: resolution,
                policy: policy))
    }

    @Test func `rejects pathlike positionals for safe bins`() {
        let policy = ExecSafeBinPolicy(
            safeBins: Set(["wacli"]),
            profilesByName: [
                "wacli": ExecSafeBinProfile(
                    minPositional: nil,
                    maxPositional: 1,
                    allowedValueFlags: Set(),
                    deniedFlags: Set()),
            ],
            trustedDirs: Set(["/tmp/openclaw-cleanroom/bin"]))
        let resolution = ExecCommandResolution(
            rawExecutable: "wacli",
            resolvedPath: "/tmp/openclaw-cleanroom/bin/wacli",
            executableName: "wacli",
            cwd: nil)

        #expect(
            !ExecSafeBins._testIsAllowed(
                command: ["wacli", "../founder-store"],
                resolution: resolution,
                policy: policy))
    }

    @Test func `allows lane local wacli auth helper via safe bin profile`() {
        let policy = ExecSafeBinPolicy(
            safeBins: Set(["wacli-auth-local.sh"]),
            profilesByName: [
                "wacli-auth-local.sh": ExecSafeBinProfile(
                    minPositional: nil,
                    maxPositional: 1,
                    allowedValueFlags: Set([
                        "--session",
                        "--wait-ms",
                        "--idle-exit",
                        "--timeout-ms",
                    ]),
                    deniedFlags: Set()),
            ],
            trustedDirs: Set(["/tmp/openclaw-cleanroom/bin"]))
        let resolution = ExecCommandResolution(
            rawExecutable: "wacli-auth-local.sh",
            resolvedPath: "/tmp/openclaw-cleanroom/bin/wacli-auth-local.sh",
            executableName: "wacli-auth-local.sh",
            cwd: nil)

        #expect(
            ExecSafeBins._testIsAllowed(
                command: ["wacli-auth-local.sh", "start", "--session", "abc123", "--wait-ms", "5000"],
                resolution: resolution,
                policy: policy))
        #expect(
            !ExecSafeBins._testIsAllowed(
                command: ["wacli-auth-local.sh", "start", "--store", "/Users/user/.wacli"],
                resolution: resolution,
                policy: policy))
    }
}
