import Foundation

@main
enum JarvisGatewayWatchdogMain {
    private static let checkInterval: Duration = .seconds(15)
    private static let healthTimeout: TimeInterval = 5

    static func main() async {
        do {
            let environment = try ManagedGatewayWatchdogEnvironment.resolve(
                processEnvironment: ProcessInfo.processInfo.environment)
            var runner = ManagedGatewayWatchdogRunner(environment: environment)
            await runner.run(once: CommandLine.arguments.contains("--once"))
        } catch {
            // launchd captures stderr in a bounded app-owned log. Do not print
            // inherited environment, plist contents, config, or command output.
            FileHandle.standardError.write(
                Data("[jarvis-gateway-watchdog] refused: \(error.localizedDescription)\n".utf8))
        }
    }

    private struct ManagedGatewayWatchdogRunner {
        let environment: ManagedGatewayWatchdogEnvironment
        private var policy = ManagedGatewayWatchdogPolicy()
        private let fileManager = FileManager.default

        init(environment: ManagedGatewayWatchdogEnvironment) {
            self.environment = environment
        }

        mutating func run(once: Bool) async {
            let store = ManagedGatewayWatchdogStateStore(
                stateURL: self.environment.stateURL,
                incidentURL: self.environment.incidentURL)
            var state = store.load()
            var lastPersistedAt = state.lastCheckedAt ?? .distantPast

            repeat {
                let now = Date()
                let previousState = state
                let observation = await self.observe()
                let action = self.policy.evaluate(
                    observation: observation,
                    now: now,
                    state: &state)

                await self.apply(action, now: now, state: &state, store: store)
                // Persist every meaningful transition, but cap steady healthy
                // writes at once per five minutes to avoid needless disk churn.
                if once ||
                    self.hasMaterialChange(from: previousState, to: state) ||
                    now.timeIntervalSince(lastPersistedAt) >= 5 * 60
                {
                    do {
                        try store.save(state)
                        lastPersistedAt = now
                    } catch {
                        self.log("state-write-failed")
                    }
                }
                if once { return }
                try? await Task.sleep(for: JarvisGatewayWatchdogMain.checkInterval)
            } while !Task.isCancelled
        }

        private func hasMaterialChange(
            from previous: ManagedGatewayWatchdogState,
            to current: ManagedGatewayWatchdogState) -> Bool
        {
            previous.observedPID != current.observedPID ||
                previous.pidFirstObservedAt != current.pidFirstObservedAt ||
                previous.consecutiveFailures != current.consecutiveFailures ||
                previous.lastRecoveryAttemptAt != current.lastRecoveryAttemptAt ||
                previous.recoveryPendingSince != current.recoveryPendingSince ||
                previous.lastNotificationAt != current.lastNotificationAt ||
                previous.incidentActive != current.incidentActive ||
                previous.lastOutcome != current.lastOutcome
        }

        private func observe() async -> ManagedGatewayWatchdogPolicy.Observation {
            if self.fileManager.fileExists(atPath: self.environment.disableLaunchAgentURL.path) {
                return .suppressed(reason: "launchagent-disabled")
            }
            if self.fileManager.fileExists(atPath: self.environment.releaseLockURL.path) {
                // The release lock primitive owns stale-lock recovery. The
                // watchdog only observes its presence and always fails closed.
                return .suppressed(reason: "release-lock")
            }

            switch self.environment.validateGatewayOwnership(fileManager: self.fileManager) {
            case .success:
                break
            case let .failure(error):
                return .wrongOwnership(reason: error.localizedDescription)
            }

            guard let snapshot = self.readRunningGateway() else {
                return .unavailable(reason: "gateway-not-running")
            }
            return await .running(pid: snapshot.pid, healthy: self.healthz())
        }

        private func readRunningGateway() -> ManagedGatewayJobSnapshot? {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = [
                "print",
                "gui/\(getuid())/\(ManagedGatewayWatchdogEnvironment.gatewayLabel)",
            ]
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else { return nil }
                return ManagedGatewayJobSnapshot.parse(String(decoding: data, as: UTF8.self))
            } catch {
                return nil
            }
        }

        private func healthz() async -> Bool {
            guard let url = URL(string: "http://127.0.0.1:\(self.environment.port)/healthz") else {
                return false
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = JarvisGatewayWatchdogMain.healthTimeout
            configuration.timeoutIntervalForResource = JarvisGatewayWatchdogMain.healthTimeout
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            do {
                let (_, response) = try await session.data(from: url)
                guard let http = response as? HTTPURLResponse else { return false }
                return (200...299).contains(http.statusCode)
            } catch {
                return false
            }
        }

        private mutating func apply(
            _ action: ManagedGatewayWatchdogPolicy.Action,
            now: Date,
            state: inout ManagedGatewayWatchdogState,
            store: ManagedGatewayWatchdogStateStore) async
        {
            switch action {
            case .none:
                return
            case .clearIncident:
                try? store.setIncident(active: false, reason: nil, now: now)
                ManagedGatewayRecoveryNotification.clear()
                self.log("healthy-incident-cleared")
            case let .recover(pid):
                if let blocker = self.recoveryMutationBlocker(expectedPID: pid) {
                    // evaluate() granted a lease before the final probe
                    // completed. Cancel only that unconsumed lease, then let
                    // the normal suppression/ownership policy reset the epoch.
                    state.lastRecoveryAttemptAt = nil
                    _ = self.policy.evaluate(
                        observation: blocker,
                        now: Date(),
                        state: &state)
                    self.log("recovery-cancelled-before-mutation")
                    return
                }
                // The policy has already granted the recovery lease. Make that
                // backoff durable before launchctl so a helper crash cannot
                // forget the attempt and create a restart loop.
                do {
                    try store.save(state)
                } catch {
                    self.log("recovery-lease-write-failed")
                    return
                }
                let succeeded = self.kickstartExistingGateway()
                self.log(succeeded ? "recovery-command-succeeded pid=\(pid)" : "recovery-command-failed pid=\(pid)")
                let resultAction = self.policy.recordRecoveryResult(
                    succeeded: succeeded,
                    now: Date(),
                    state: &state)
                await self.apply(resultAction, now: Date(), state: &state, store: store)
            case let .notify(reason):
                try? store.setIncident(
                    active: true,
                    reason: reason,
                    notificationDelivered: false,
                    now: now)
                let delivered = await ManagedGatewayRecoveryNotification.send()
                try? store.setIncident(
                    active: true,
                    reason: reason,
                    notificationDelivered: delivered,
                    now: now)
                if !delivered {
                    self.launchContainingJarvisAppInBackground()
                }
                self.log("manual-recovery-required")
            }
        }

        private func recoveryMutationBlocker(
            expectedPID: Int32) -> ManagedGatewayWatchdogPolicy.Observation?
        {
            // Revalidate immediately before launchctl. A release or deliberate
            // stop can begin during the five-second health request that granted
            // recovery, and that newer owner always wins.
            if self.fileManager.fileExists(atPath: self.environment.disableLaunchAgentURL.path) {
                return .suppressed(reason: "launchagent-disabled")
            }
            if self.fileManager.fileExists(atPath: self.environment.releaseLockURL.path) {
                return .suppressed(reason: "release-lock")
            }
            if case let .failure(error) =
                self.environment.validateGatewayOwnership(fileManager: self.fileManager)
            {
                return .wrongOwnership(reason: error.localizedDescription)
            }
            guard let snapshot = self.readRunningGateway(), snapshot.pid == expectedPID else {
                return .unavailable(reason: "gateway-changed-before-recovery")
            }
            return nil
        }

        private func launchContainingJarvisAppInBackground() {
            // A directly executed nested helper may not own Notification Center
            // authorization on every macOS build. Wake the containing app only
            // as a fallback; it imports the same receipt and sends through the
            // established native notification manager without showing a window.
            let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            let app = executable
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
            guard app.pathExtension == "app", app.lastPathComponent == "Jarvis.app" else { return }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-gj", app.path]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
        }

        private func kickstartExistingGateway() -> Bool {
            // Ownership was validated immediately before this call. Kickstart
            // preserves the exact existing plist and cannot repoint the runtime.
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = [
                "kickstart",
                "-k",
                "gui/\(getuid())/\(ManagedGatewayWatchdogEnvironment.gatewayLabel)",
            ]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus == 0
            } catch {
                return false
            }
        }

        private func log(_ message: String) {
            FileHandle.standardOutput.write(
                Data("[jarvis-gateway-watchdog] \(message)\n".utf8))
        }
    }
}
