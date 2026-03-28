import AppKit
import Foundation
import Observation

struct ChromeProfileCandidate: Equatable, Identifiable {
    let directoryName: String
    let displayName: String
    let subtitle: String?
    let lastUsedAt: Date?
    let isDefaultProfile: Bool

    var id: String { self.directoryName }

    var initials: String {
        let words = self.displayName
            .split(whereSeparator: \.isWhitespace)
            .prefix(2)
            .compactMap { $0.first }
        let value = String(words)
        return value.isEmpty ? "C" : value.uppercased()
    }

    var lastUsedDescription: String? {
        guard let lastUsedAt else { return nil }
        return RelativeDateTimeFormatter().localizedString(for: lastUsedAt, relativeTo: Date())
    }
}

enum BrowserRuntimeFailureTemplateKind: CaseIterable {
    case publicTaskFallback
    case signedInTaskStopped
    case signInRequired

    var title: String {
        switch self {
        case .publicTaskFallback:
            return "Public sites still work"
        case .signedInTaskStopped:
            return "Your logged-in sites stay protected"
        case .signInRequired:
            return "You sign in yourself"
        }
    }

    var body: String {
        switch self {
        case .publicTaskFallback:
            return "If a page does not need your account, OpenClaw can still open it in its own browser and tell you what happened."
        case .signedInTaskStopped:
            return "If a task needs one of your logged-in sites, OpenClaw stops and explains the problem instead of guessing."
        case .signInRequired:
            return "If a site needs you to log in, OpenClaw opens the page and waits for you."
        }
    }
}

enum BrowserSetupPhase: Equatable {
    case idle
    case checking
    case chromeMissing
    case noProfiles
    case confirm(ChromeProfileCandidate)
    case choose([ChromeProfileCandidate])
    case ready(ChromeProfileCandidate)
    case failed(String)
}

@MainActor
@Observable
final class BrowserSetupModel {
    private(set) var phase: BrowserSetupPhase = .idle
    private(set) var isApplyingSelection = false
    private(set) var statusLine: String?
    private var lastAutoRecoveryFailureMessage: String?

    private let defaults: UserDefaults
    private let detectChromeExecutable: () -> URL?
    private let loadProfiles: () -> [ChromeProfileCandidate]
    private let persistSelectionToConfig: (ChromeProfileCandidate) -> Void
    private let clearSelectionFromConfig: () -> Void
    private let verifySelectionReadiness: (ChromeProfileCandidate) async -> String?
    private let allowConfigOnlyRestore: Bool
    private let restoredSelectionRequiresConfirmation: Bool
    private var detectedProfiles: [ChromeProfileCandidate] = []

    init(
        defaults: UserDefaults = .standard,
        allowConfigOnlyRestore: Bool = true,
        restoredSelectionRequiresConfirmation: Bool = false,
        detectChromeExecutable: (() -> URL?)? = nil,
        loadProfiles: (() -> [ChromeProfileCandidate])? = nil,
        persistSelectionToConfig: ((ChromeProfileCandidate) -> Void)? = nil,
        clearSelectionFromConfig: (() -> Void)? = nil,
        verifySelectionReadiness: ((ChromeProfileCandidate) async -> String?)? = nil)
    {
        self.defaults = defaults
        self.allowConfigOnlyRestore = allowConfigOnlyRestore
        self.restoredSelectionRequiresConfirmation = restoredSelectionRequiresConfirmation
        self.detectChromeExecutable = detectChromeExecutable ?? { BrowserSetupModel.detectChromeExecutable() }
        self.loadProfiles = loadProfiles ?? { BrowserSetupModel.loadChromeProfiles() }
        self.persistSelectionToConfig = persistSelectionToConfig ?? { profile in
            BrowserSetupModel.persistConsumerBrowserSelection(profile)
        }
        self.clearSelectionFromConfig = clearSelectionFromConfig ?? {
            BrowserSetupModel.clearConsumerBrowserSelectionFromConfig()
        }
        self.verifySelectionReadiness = verifySelectionReadiness ?? { profile in
            await BrowserSetupModel.verifyConsumerBrowserSelection(expectedProfile: profile)
        }
    }

    var isComplete: Bool {
        if case .ready = self.phase {
            return true
        }
        return false
    }

    var selectedProfile: ChromeProfileCandidate? {
        if case let .ready(profile) = self.phase {
            return profile
        }
        return nil
    }

    var selectedProfileName: String? {
        self.defaults.string(forKey: browserSelectedChromeProfileNameKey)
    }

    func refreshIfNeeded() async {
        guard self.phase == .idle else { return }
        await self.refresh()
    }

    func retryTransientFailureIfNeeded() async {
        guard case let .failed(message) = self.phase else { return }
        guard Self.isTransientReadinessFailure(message) else { return }
        // The post-onboarding shell can briefly probe browser readiness before
        // the consumer lane has fully restabilized. Retry that exact transient
        // failure once on the next app activation so General does not stay stuck
        // showing a fake-broken browser card after setup already succeeded.
        guard self.lastAutoRecoveryFailureMessage != message else { return }
        self.lastAutoRecoveryFailureMessage = message
        await self.refresh()
    }

    func refresh() async {
        self.phase = .checking
        self.statusLine = "Checking Chrome on this Mac…"

        guard self.detectChromeExecutable() != nil else {
            self.detectedProfiles = []
            self.clearSelection()
            self.clearSelectionFromConfig()
            self.phase = .chromeMissing
            self.statusLine = "Google Chrome is required for browser setup."
            self.lastAutoRecoveryFailureMessage = nil
            return
        }

        let profiles = self.loadProfiles()
        self.detectedProfiles = profiles

        guard !profiles.isEmpty else {
            self.clearSelection()
            self.clearSelectionFromConfig()
            self.phase = .noProfiles
            self.statusLine = "Open Chrome once on this Mac so OpenClaw can find your profile."
            self.lastAutoRecoveryFailureMessage = nil
            return
        }

        if let selected = self.restoreSelection(from: profiles) {
            // Onboarding should acknowledge prior Chrome choices explicitly so the
            // user sees a real browser step even when this Mac already has enough
            // state to prefill it. Settings keeps the faster auto-ready behavior.
            if self.restoredSelectionRequiresConfirmation {
                self.phase = .confirm(selected)
                self.statusLine = "We found your Chrome profile."
                self.lastAutoRecoveryFailureMessage = nil
                return
            }
            self.statusLine = "Checking browser readiness…"
            if let failure = await self.verifySelectionReadiness(selected) {
                self.phase = .failed(failure)
                self.statusLine = failure
                return
            }
            self.phase = .ready(selected)
            self.statusLine = "Connected to \(selected.displayName). OpenClaw can use its own Chrome copy when needed."
            self.lastAutoRecoveryFailureMessage = nil
            return
        }

        if profiles.count == 1, let first = profiles.first {
            self.phase = .confirm(first)
            self.statusLine = "We found one Chrome profile."
            self.lastAutoRecoveryFailureMessage = nil
            return
        }

        self.phase = .choose(profiles)
        self.statusLine = "Choose the Chrome profile OpenClaw should use."
        self.lastAutoRecoveryFailureMessage = nil
    }

    func chooseProfile(_ profile: ChromeProfileCandidate) async {
        self.isApplyingSelection = true
        self.statusLine = "Saving your Chrome profile…"
        defer { self.isApplyingSelection = false }

        guard self.persistSelection(profile) else {
            self.phase = .failed("OpenClaw could not save your Chrome profile inside this instance.")
            self.statusLine = "OpenClaw could not save your Chrome profile."
            return
        }
        self.persistSelectionToConfig(profile)
        self.statusLine = "Checking browser readiness…"

        if let failure = await self.verifySelectionReadiness(profile) {
            self.phase = .failed(failure)
            self.statusLine = failure
            return
        }
        self.phase = .ready(profile)
        self.statusLine = "Connected to \(profile.displayName). OpenClaw can use its own Chrome copy when needed."
        self.lastAutoRecoveryFailureMessage = nil
    }

    func clearProfileSelection() {
        self.clearSelection()
        self.clearSelectionFromConfig()
        self.lastAutoRecoveryFailureMessage = nil
        if self.detectedProfiles.count == 1, let first = self.detectedProfiles.first {
            self.phase = .confirm(first)
            self.statusLine = "We found one Chrome profile."
        } else if !self.detectedProfiles.isEmpty {
            self.phase = .choose(self.detectedProfiles)
            self.statusLine = "Choose the Chrome profile OpenClaw should use."
        } else {
            self.phase = .idle
            self.statusLine = nil
        }
    }

    private static func isTransientReadinessFailure(_ message: String) -> Bool {
        let normalized = message.lowercased()
        return normalized.contains("browser readiness failed") ||
            normalized.contains("returned unreadable output")
    }

    func openChromeDownloadPage() {
        guard let url = URL(string: "https://www.google.com/chrome/") else { return }
        NSWorkspace.shared.open(url)
    }

    // Non-trivial: we read Chrome's Local State file directly so the user never
    // has to inspect profile paths or internal browser pages.
    private static func loadChromeProfiles() -> [ChromeProfileCandidate] {
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Google/Chrome", isDirectory: true)

        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles])
        else {
            return []
        }

        let directories = entries
            .filter {
                guard let resourceValues = try? $0.resourceValues(forKeys: [.isDirectoryKey]) else { return false }
                guard resourceValues.isDirectory == true else { return false }
                let name = $0.lastPathComponent
                return name == "Default" || name.hasPrefix("Profile ")
            }
            .map(\.lastPathComponent)

        let infoCache = Self.loadProfileInfoCache(root: root)
        let profiles = directories.map { directoryName in
            let metadata = infoCache[directoryName] ?? [:]
            let displayName = Self.profileDisplayName(directoryName: directoryName, metadata: metadata)
            let subtitle = Self.profileSubtitle(metadata: metadata)
            let lastUsedAt = Self.profileLastUsedAt(metadata: metadata)
            return ChromeProfileCandidate(
                directoryName: directoryName,
                displayName: displayName,
                subtitle: subtitle,
                lastUsedAt: lastUsedAt,
                isDefaultProfile: directoryName == "Default")
        }

        return profiles.sorted { lhs, rhs in
            switch (lhs.lastUsedAt, rhs.lastUsedAt) {
            case let (.some(left), .some(right)) where left != right:
                return left > right
            case (.some, .none):
                return true
            case (.none, .some):
                return false
            default:
                if lhs.isDefaultProfile != rhs.isDefaultProfile {
                    return lhs.isDefaultProfile
                }
                return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
            }
        }
    }

    private static func loadProfileInfoCache(root: URL) -> [String: [String: Any]] {
        let localStateURL = root.appendingPathComponent("Local State")
        guard let data = try? Data(contentsOf: localStateURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let profile = json["profile"] as? [String: Any],
              let infoCache = profile["info_cache"] as? [String: [String: Any]]
        else {
            return [:]
        }
        return infoCache
    }

    private static func profileDisplayName(directoryName: String, metadata: [String: Any]) -> String {
        if let name = (metadata["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty
        {
            return name
        }
        if directoryName == "Default" {
            return "Default Chrome"
        }
        return directoryName
    }

    private static func profileSubtitle(metadata: [String: Any]) -> String? {
        let keys = ["user_name", "gaia_name", "shortcut_name"]
        for key in keys {
            if let value = (metadata[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty
            {
                return value
            }
        }
        return nil
    }

    private static func profileLastUsedAt(metadata: [String: Any]) -> Date? {
        let rawValue = metadata["active_time"] ?? metadata["activeTime"]
        let numeric: Double?
        if let number = rawValue as? NSNumber {
            numeric = number.doubleValue
        } else if let string = rawValue as? String {
            numeric = Double(string)
        } else {
            numeric = nil
        }
        guard let numeric, numeric > 0 else { return nil }
        return Date(timeIntervalSince1970: numeric)
    }

    private func restoreSelection(from profiles: [ChromeProfileCandidate]) -> ChromeProfileCandidate? {
        let hasDefaultsSelection = self.hasPersistedDefaultsSelection()

        // Config is the runtime source of truth. If we only trust UserDefaults here,
        // the setup sheet can claim success while the actual browser runtime stays global.
        if let selectedID = OpenClawConfigFile.selectedChromeProfileDirectoryName(),
           let selected = profiles.first(where: { $0.directoryName == selectedID })
        {
            // Some bootstrap paths can preseed browser.user.sourceProfileName before the
            // consumer has explicitly confirmed Chrome in onboarding. Honor config-only
            // restore in Settings, but keep first-run onboarding honest and require an
            // explicit confirmation when no app-local browser choice was persisted yet.
            guard self.allowConfigOnlyRestore || hasDefaultsSelection else {
                self.clearSelectionFromConfig()
                return nil
            }
            self.persistDefaultsSelection(selected)
            return selected
        }

        guard let selectedID = self.defaults.string(forKey: browserSelectedChromeProfileIDKey) else {
            return nil
        }
        guard let selected = profiles.first(where: { $0.directoryName == selectedID }) else {
            return nil
        }

        // Backfill legacy defaults-only selections into the instance-scoped config so
        // existing users do not have to re-pick their Chrome profile after upgrading.
        _ = self.persistRuntimeSelection(selected)
        return selected
    }

    private func hasPersistedDefaultsSelection() -> Bool {
        guard let selectedID = self.defaults.string(forKey: browserSelectedChromeProfileIDKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return false
        }
        return !selectedID.isEmpty
    }

    private func persistSelection(_ profile: ChromeProfileCandidate) -> Bool {
        self.persistDefaultsSelection(profile)
        return self.persistRuntimeSelection(profile)
    }

    private func persistDefaultsSelection(_ profile: ChromeProfileCandidate) {
        self.defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
        self.defaults.set(profile.displayName, forKey: browserSelectedChromeProfileNameKey)
    }

    private func persistRuntimeSelection(_ profile: ChromeProfileCandidate) -> Bool {
        guard OpenClawConfigFile.setSelectedChromeProfileDirectoryName(profile.directoryName) else {
            return false
        }

        let userDataDir = OpenClawConfigFile.managedBrowserUserDataDirURL()
        do {
            // Create the instance-scoped browser root immediately so local QA can verify
            // browser isolation before the Node runtime launches Chrome for the first time.
            try FileManager.default.createDirectory(
                at: userDataDir,
                withIntermediateDirectories: true)
            return true
        } catch {
            return false
        }
    }

    private func clearSelection() {
        self.defaults.removeObject(forKey: browserSelectedChromeProfileIDKey)
        self.defaults.removeObject(forKey: browserSelectedChromeProfileNameKey)
        _ = OpenClawConfigFile.clearSelectedChromeProfileDirectoryName()
    }

    private static func detectChromeExecutable() -> URL? {
        let candidates = [
            URL(fileURLWithPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) })
    }
}
