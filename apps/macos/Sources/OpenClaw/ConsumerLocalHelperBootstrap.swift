import Foundation
import Observation

@MainActor
@Observable
final class ConsumerLocalHelperBootstrap {
    static let shared = ConsumerLocalHelperBootstrap()

    private(set) var installedLocation: String?
    private(set) var statusMessage: String?
    private(set) var isInstalling = false
    private var installTask: Task<CLIInstaller.EnsureResult, Never>?

    private init() {
        self.installedLocation = CLIInstaller.installedLocation()
    }

    var hasFailure: Bool {
        (self.statusMessage ?? "").hasPrefix("Install failed:")
    }

    var shouldShowStatusCard: Bool {
        self.isInstalling || self.hasFailure || self.installedLocation == nil
    }

    func refresh() {
        self.installedLocation = CLIInstaller.installedLocation()
    }

    func ensureInstalledIfNeeded(connectionMode: AppState.ConnectionMode) async {
        guard Self.shouldBootstrap(
            isConsumer: AppFlavor.current.isConsumer,
            connectionMode: connectionMode,
            installedLocation: self.installedLocation)
        else {
            self.refresh()
            return
        }

        if let installTask = self.installTask {
            _ = await installTask.value
            self.refresh()
            return
        }

        self.isInstalling = true
        self.statusMessage = "Preparing OpenClaw on this Mac…"

        // The consumer app should own local bootstrap instead of bouncing the
        // user into Terminal. Keep one shared task so launch-time startup and
        // the onboarding surface do not race duplicate installs.
        let task = Task<CLIInstaller.EnsureResult, Never> {
            await CLIInstaller.ensureInstalledIfNeeded { message in
                await MainActor.run {
                    ConsumerLocalHelperBootstrap.shared.statusMessage =
                        Self.consumerStatusMessage(for: message)
                }
            }
        }
        self.installTask = task
        let result = await task.value
        self.installTask = nil
        self.isInstalling = false
        self.refresh()

        switch result {
        case let .alreadyInstalled(location), let .installed(location):
            self.installedLocation = location
            self.statusMessage = nil
        case let .failed(message):
            if self.statusMessage == nil || self.statusMessage?.isEmpty == true {
                self.statusMessage = message
            }
        }
    }

    static func shouldBootstrap(
        isConsumer: Bool,
        connectionMode: AppState.ConnectionMode,
        installedLocation: String?) -> Bool
    {
        guard isConsumer else { return false }
        guard installedLocation == nil else { return false }
        switch connectionMode {
        case .local, .unconfigured:
            return true
        case .remote:
            return false
        }
    }

    private static func consumerStatusMessage(for raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return "Preparing OpenClaw on this Mac…"
        }
        if trimmed == "Installing openclaw CLI…" {
            return "Preparing OpenClaw on this Mac…"
        }
        if trimmed.hasPrefix("Installed openclaw") {
            return "OpenClaw is ready on this Mac."
        }
        return trimmed
    }
}
