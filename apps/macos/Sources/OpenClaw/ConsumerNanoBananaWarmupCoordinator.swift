import Foundation
import OSLog

actor ConsumerNanoBananaWarmupCoordinator {
    static let shared = ConsumerNanoBananaWarmupCoordinator()

    typealias ShellRunner = @Sendable (_ command: [String], _ cwd: String?, _ env: [String: String]?, _ timeout: Double?) async -> ShellExecutor.ShellResult

    struct Dependencies {
        var currentDate: @Sendable () -> Date
        var bundledRuntimeRootURL: @Sendable () -> URL
        var shellRunner: ShellRunner

        static var standard: Self {
            Self(
                currentDate: Date.init,
                // Warm the packaged runtime, not the developer checkout. The
                // consumer build must be self-sufficient once it has seeded its
                // own install prefix under Application Support.
                bundledRuntimeRootURL: {
                    ConsumerRuntime.installPrefixURL
                        .appendingPathComponent("lib", isDirectory: true)
                        .appendingPathComponent("openclaw-bundled", isDirectory: true)
                },
                shellRunner: { command, cwd, env, timeout in
                    await ShellExecutor.runDetailed(
                        command: command,
                        cwd: cwd,
                        env: env,
                        timeout: timeout)
                })
        }
    }

    struct WarmupMarker: Codable, Equatable {
        let version: Int
        let lastAttemptAt: Date
        let lastSuccessAt: Date?
        let lastFailureAt: Date?
        let failureCount: Int
        let nextRetryAt: Date?
        let lastError: String?
    }

    private struct WarmupOutcome {
        let success: Bool
        let errorMessage: String?
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "consumer.nano-banana.warmup")
    private static let markerFileName = "nano-banana-pro-warmup.json"
    private static let warmupVersion = 1
    private static let warmupScriptRelativePath = "skills/nano-banana-pro/scripts/generate_image.py"

    private let stateURL: URL
    private let dependencies: Dependencies
    private var warmupTask: Task<Void, Never>?

    init(
        stateURL: URL = ConsumerNanoBananaWarmupCoordinator.defaultStateURL(),
        dependencies: Dependencies = .standard)
    {
        self.stateURL = stateURL
        self.dependencies = dependencies
    }

    private static func defaultStateURL() -> URL {
        ConsumerRuntime.stateDirURL
            .appendingPathComponent("warmup", isDirectory: true)
            .appendingPathComponent(self.markerFileName)
    }

    func startIfNeeded() async -> Bool {
        guard AppFlavor.current.isConsumer else { return false }
        guard self.warmupTask == nil else { return false }
        guard self.shouldAttemptWarmup(now: self.dependencies.currentDate()) else { return false }

        let task = Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            let outcome = await self.performWarmup()
            await self.finishWarmup(outcome)
        }
        self.warmupTask = task
        return true
    }

    func waitForCurrentWarmup() async {
        let task = self.warmupTask
        await task?.value
    }

    func shouldAttemptWarmup(now: Date) -> Bool {
        guard let marker = self.loadMarker(), marker.version == Self.warmupVersion else {
            return true
        }
        if marker.lastSuccessAt != nil {
            return false
        }
        guard let nextRetryAt = marker.nextRetryAt else {
            return true
        }
        return nextRetryAt <= now
    }

    func loadMarker() -> WarmupMarker? {
        guard FileManager().fileExists(atPath: self.stateURL.path) else { return nil }
        guard let data = try? Data(contentsOf: self.stateURL) else { return nil }
        return try? JSONDecoder().decode(WarmupMarker.self, from: data)
    }

    private func performWarmup() async -> WarmupOutcome {
        let bundledRuntimeRoot = self.dependencies.bundledRuntimeRootURL()
        let scriptURL = bundledRuntimeRoot.appendingPathComponent(Self.warmupScriptRelativePath)
        let cacheURL = Self.cacheDirectoryURL(for: self.stateURL)

        do {
            try FileManager().createDirectory(at: cacheURL, withIntermediateDirectories: true)
        } catch {
            // Cache creation should not block the background warmup from
            // proceeding; uv can still materialize its own cache path if needed.
            Self.logger.debug("nano banana warmup cache dir could not be precreated: \(error.localizedDescription, privacy: .public)")
        }

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        env["UV_CACHE_DIR"] = cacheURL.path

        let command = Self.warmupCommand(scriptPath: scriptURL.path)
        let result = await self.dependencies.shellRunner(command, bundledRuntimeRoot.path, env, 600)
        if result.success {
            return WarmupOutcome(success: true, errorMessage: nil)
        }

        let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = [result.errorMessage, stderr.isEmpty ? nil : stderr, stdout.isEmpty ? nil : stdout]
            .compactMap { $0 }
            .first ?? "warmup failed"
        return WarmupOutcome(success: false, errorMessage: detail)
    }

    private func finishWarmup(_ outcome: WarmupOutcome) async {
        defer { self.warmupTask = nil }

        let now = self.dependencies.currentDate()
        let marker = outcome.success
            ? Self.successMarker(now: now)
            : self.failureMarker(now: now, errorMessage: outcome.errorMessage)

        do {
            try self.writeMarker(marker)
            if outcome.success {
                Self.logger.info("nano banana warmup completed and cached")
            } else {
                Self.logger.warning("nano banana warmup failed; retrying after backoff")
            }
        } catch {
            Self.logger.error("nano banana warmup marker write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func failureMarker(now: Date, errorMessage: String?) -> WarmupMarker {
        let previous = self.loadMarker().flatMap { $0.version == Self.warmupVersion ? $0 : nil }
        let failureCount = (previous?.failureCount ?? 0) + 1
        let nextRetryAt = now.addingTimeInterval(Self.backoffInterval(forFailureCount: failureCount))
        return WarmupMarker(
            version: Self.warmupVersion,
            lastAttemptAt: now,
            lastSuccessAt: nil,
            lastFailureAt: now,
            failureCount: failureCount,
            nextRetryAt: nextRetryAt,
            lastError: errorMessage)
    }

    private static func successMarker(now: Date) -> WarmupMarker {
        WarmupMarker(
            version: Self.warmupVersion,
            lastAttemptAt: now,
            lastSuccessAt: now,
            lastFailureAt: nil,
            failureCount: 0,
            nextRetryAt: nil,
            lastError: nil)
    }

    static func warmupCommand(scriptPath: String) -> [String] {
        ["uv", "run", scriptPath, "--warmup"]
    }

    static func backoffInterval(forFailureCount failureCount: Int) -> TimeInterval {
        guard failureCount > 0 else { return 0 }
        let base: TimeInterval = 5 * 60
        let maxBackoff: TimeInterval = 6 * 60 * 60
        let multiplier = Double(1 << max(0, failureCount - 1))
        return min(maxBackoff, base * multiplier)
    }

    private func writeMarker(_ marker: WarmupMarker) throws {
        try FileManager().createDirectory(
            at: self.stateURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(marker)
        try data.write(to: self.stateURL, options: .atomic)
    }

    private static func cacheDirectoryURL(for stateURL: URL) -> URL {
        stateURL
            .deletingLastPathComponent()
            .appendingPathComponent("nano-banana-pro-uv-cache", isDirectory: true)
    }
}
