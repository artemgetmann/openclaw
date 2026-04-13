import Foundation
import Observation

@MainActor
@Observable
final class ConsumerLocalHelperBootstrap {
    static let shared = ConsumerLocalHelperBootstrap()

    private(set) var installedLocation: String?
    private(set) var statusMessage: String?
    private(set) var isInstalling = false
    private var bootstrapTask: Task<CLIInstaller.EnsureResult, Never>?

    private init() {
        self.installedLocation = Self.consumerInstalledLocation()
    }

    var hasFailure: Bool {
        let message = self.statusMessage ?? ""
        return message.hasPrefix("Install failed:") || message.hasPrefix("Repair failed:")
    }

    var shouldShowStatusCard: Bool {
        self.isInstalling || self.hasFailure || self.installedLocation == nil
    }

    func refresh() {
        self.installedLocation = Self.consumerInstalledLocation()
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

        if let bootstrapTask = self.bootstrapTask {
            _ = await bootstrapTask.value
            self.refresh()
            return
        }

        self.isInstalling = true
        self.statusMessage = "Repairing OpenClaw from the packaged app…"

        // Keep one shared repair task so launch-time startup and onboarding do
        // not race each other. Consumer repair stays bundled-only so we never
        // bounce the user into a remote installer or Terminal.
        let task = Task<CLIInstaller.EnsureResult, Never> {
            await CLIInstaller.ensureInstalledIfNeeded(
                bundle: .main,
                fileManager: .default)
        }
        self.bootstrapTask = task
        let result = await task.value
        self.bootstrapTask = nil
        self.isInstalling = false
        self.refresh()

        switch result {
        case let .alreadyInstalled(location), let .installed(location):
            self.installedLocation = location
            self.statusMessage = nil
        case let .failed(message):
            self.statusMessage = message
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

    private static func consumerInstalledLocation(fileManager: FileManager = .default) -> String? {
        CLIInstaller.installedLocation(
            searchPaths: [ConsumerRuntime.installPrefixURL.appendingPathComponent("bin").path],
            fileManager: fileManager)
    }
}
