import Foundation

enum ConsumerSetupResumeBlocker: Equatable {
    case missingConfig
    case browser
    case permissions
    case model
    case telegram
}

enum ConsumerSetupResumeDecision: Equatable {
    case complete
    case blocked(ConsumerSetupResumeBlocker)
}

@MainActor
@Observable
final class ConsumerSetupResumeModel {
    typealias ConfigExists = @Sendable () -> Bool
    typealias LoadTelegramState = @MainActor @Sendable (_ channelsStore: ChannelsStore) async -> Void

    private let configExists: ConfigExists
    private let loadTelegramState: LoadTelegramState
    private(set) var decision: ConsumerSetupResumeDecision?
    private(set) var isChecking = false

    init(
        configExists: ConfigExists? = nil,
        loadTelegramState: LoadTelegramState? = nil)
    {
        self.configExists = configExists ?? {
            FileManager.default.fileExists(atPath: ConsumerRuntime.configURL.path)
        }
        self.loadTelegramState = loadTelegramState ?? { store in
            await store.restoreConfigDraftFromCurrentSource()
            await store.refresh(probe: true)
        }
    }

    func evaluate(
        browserSetup: BrowserSetupModel,
        modelSetup: ConsumerModelSetupModel,
        channelsStore: ChannelsStore,
        corePermissionsGranted: Bool
    ) async -> ConsumerSetupResumeDecision {
        guard AppFlavor.current.isConsumer else {
            self.decision = .blocked(.missingConfig)
            return .blocked(.missingConfig)
        }

        self.isChecking = true
        defer { self.isChecking = false }

        guard self.configExists() else {
            self.decision = .blocked(.missingConfig)
            return .blocked(.missingConfig)
        }

        // Use the same BrowserSetupModel as the visible card so a failed resume
        // probe leaves the user on the browser card with the actual blocker.
        await browserSetup.refreshForSetupResume()
        guard browserSetup.isComplete else {
            self.decision = .blocked(.browser)
            return .blocked(.browser)
        }

        guard corePermissionsGranted else {
            self.decision = .blocked(.permissions)
            return .blocked(.permissions)
        }

        await modelSetup.refresh()
        guard modelSetup.isComplete else {
            self.decision = .blocked(.model)
            return .blocked(.model)
        }

        await self.loadTelegramState(channelsStore)
        if channelsStore.consumerTelegramReadyForFirstTask() ||
            channelsStore.completeConsumerTelegramFirstTaskVerificationForResumeIfSafe()
        {
            self.decision = .complete
            return .complete
        }

        self.decision = .blocked(.telegram)
        return .blocked(.telegram)
    }
}
