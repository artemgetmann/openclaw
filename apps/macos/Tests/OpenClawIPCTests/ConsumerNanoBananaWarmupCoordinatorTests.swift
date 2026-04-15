import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ConsumerNanoBananaWarmupCoordinatorTests {
    @Test func `warmup command uses uv warmup mode`() {
        let command = ConsumerNanoBananaWarmupCoordinator.warmupCommand(
            scriptPath: "/tmp/nano-banana/generate_image.py")

        #expect(command == ["uv", "run", "/tmp/nano-banana/generate_image.py", "--warmup"])
    }

    @Test func `warmup backoff grows and caps`() {
        #expect(ConsumerNanoBananaWarmupCoordinator.backoffInterval(forFailureCount: 0) == 0)
        #expect(ConsumerNanoBananaWarmupCoordinator.backoffInterval(forFailureCount: 1) == 5 * 60)
        #expect(ConsumerNanoBananaWarmupCoordinator.backoffInterval(forFailureCount: 2) == 10 * 60)
        #expect(ConsumerNanoBananaWarmupCoordinator.backoffInterval(forFailureCount: 3) == 20 * 60)
        #expect(ConsumerNanoBananaWarmupCoordinator.backoffInterval(forFailureCount: 8) == 6 * 60 * 60)
    }

    @Test func `successful warmup writes success marker and runs from bundled runtime`() async throws {
        let stateRoot = try makeTempDirForTests()
        let bundledRoot = try makeTempDirForTests()
        let scriptPath = bundledRoot
            .appendingPathComponent("skills/nano-banana-pro/scripts/generate_image.py")
        try FileManager.default.createDirectory(at: scriptPath.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/usr/bin/env python3\n".write(to: scriptPath, atomically: true, encoding: .utf8)

        let calls = LockedBox<[([String], String?, [String: String]?)]>([])
        let coordinator = ConsumerNanoBananaWarmupCoordinator(
            stateURL: stateRoot
                .appendingPathComponent("warmup", isDirectory: true)
                .appendingPathComponent("nano-banana-pro-warmup.json"),
            dependencies: .init(
                currentDate: { Date(timeIntervalSince1970: 1_710_000_000) },
                bundledRuntimeRootURL: { bundledRoot },
                shellRunner: { command, cwd, env, _ in
                    calls.withLock { $0.append((command, cwd, env)) }
                    return ShellExecutor.ShellResult(
                        stdout: "Warmup complete.",
                        stderr: "",
                        exitCode: 0,
                        timedOut: false,
                        success: true,
                        errorMessage: nil)
                }))

        try await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let started = await coordinator.startIfNeeded()
            #expect(started)
            await coordinator.waitForCurrentWarmup()
        }

        let recordedCalls = calls.withLock { $0 }
        #expect(recordedCalls.count == 1)
        if let first = recordedCalls.first {
            #expect(first.0 == ["uv", "run", scriptPath.path, "--warmup"])
            #expect(first.1 == bundledRoot.path)
            #expect(first.2?["UV_CACHE_DIR"]?.contains("nano-banana-pro-uv-cache") == true)
        }

        let marker = await coordinator.loadMarker()
        #expect(marker?.lastSuccessAt != nil)
        #expect(marker?.lastError == nil)
        #expect(marker?.failureCount == 0)
    }

    @Test func `failed warmup writes retry marker and suppresses immediate retry`() async throws {
        let stateRoot = try makeTempDirForTests()
        let bundledRoot = try makeTempDirForTests()
        let coordinator = ConsumerNanoBananaWarmupCoordinator(
            stateURL: stateRoot
                .appendingPathComponent("warmup", isDirectory: true)
                .appendingPathComponent("nano-banana-pro-warmup.json"),
            dependencies: .init(
                currentDate: { Date(timeIntervalSince1970: 1_720_000_000) },
                bundledRuntimeRootURL: { bundledRoot },
                shellRunner: { _, _, _, _ in
                    ShellExecutor.ShellResult(
                        stdout: "",
                        stderr: "warmup failed",
                        exitCode: 1,
                        timedOut: false,
                        success: false,
                        errorMessage: "warmup failed")
                }))

        try await TestIsolation.withEnvValues(["OPENCLAW_APP_VARIANT": "consumer"]) {
            let started = await coordinator.startIfNeeded()
            #expect(started)
            await coordinator.waitForCurrentWarmup()
        }

        let marker = await coordinator.loadMarker()
        #expect(marker?.lastSuccessAt == nil)
        #expect(marker?.failureCount == 1)
        #expect(marker?.lastError == "warmup failed")
        if let marker {
            let shouldRetryImmediately = await coordinator.shouldAttemptWarmup(now: marker.lastAttemptAt)
            #expect(!shouldRetryImmediately)
        }
    }
}

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func withLock<T>(_ body: (inout Value) -> T) -> T {
        self.lock.lock()
        defer { self.lock.unlock() }
        return body(&self.value)
    }
}
