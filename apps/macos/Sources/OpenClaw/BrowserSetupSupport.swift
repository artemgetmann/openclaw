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
            return "Public task fallback"
        case .signedInTaskStopped:
            return "Signed-in task protection"
        case .signInRequired:
            return "Manual sign-in only"
        }
    }

    var body: String {
        switch self {
        case .publicTaskFallback:
            return "If your Chrome copy is unavailable for a public page, OpenClaw can switch to an isolated browser and tell you it did."
        case .signedInTaskStopped:
            return "If a task depends on your account, OpenClaw stops and explains the issue instead of silently switching browser identity."
        case .signInRequired:
            return "If a site needs login, OpenClaw opens the sign-in page and waits for you to log in yourself."
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

    private let defaults: UserDefaults
    private let detectChromeExecutable: () -> URL?
    private let loadProfiles: () -> [ChromeProfileCandidate]
    private var detectedProfiles: [ChromeProfileCandidate] = []

    init(
        defaults: UserDefaults = .standard,
        detectChromeExecutable: (() -> URL?)? = nil,
        loadProfiles: (() -> [ChromeProfileCandidate])? = nil)
    {
        self.defaults = defaults
        self.detectChromeExecutable = detectChromeExecutable ?? { BrowserSetupModel.detectChromeExecutable() }
        self.loadProfiles = loadProfiles ?? { BrowserSetupModel.loadChromeProfiles() }
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

    func refresh() async {
        self.phase = .checking
        self.statusLine = "Checking Chrome on this Mac…"

        guard self.detectChromeExecutable() != nil else {
            self.detectedProfiles = []
            self.clearSelection()
            self.phase = .chromeMissing
            self.statusLine = "Google Chrome is required for browser setup."
            return
        }

        let profiles = self.loadProfiles()
        self.detectedProfiles = profiles

        guard !profiles.isEmpty else {
            self.clearSelection()
            self.phase = .noProfiles
            self.statusLine = "Open Chrome once on this Mac so OpenClaw can find your profile."
            return
        }

        if let selected = self.restoreSelection(from: profiles) {
            self.phase = .ready(selected)
            self.statusLine = "Connected to \(selected.displayName)."
            return
        }

        if profiles.count == 1, let first = profiles.first {
            self.phase = .confirm(first)
            self.statusLine = "We found one Chrome profile."
            return
        }

        self.phase = .choose(profiles)
        self.statusLine = "Choose the Chrome profile OpenClaw should use."
    }

    func chooseProfile(_ profile: ChromeProfileCandidate) async {
        self.isApplyingSelection = true
        self.statusLine = "Saving your Chrome profile…"
        defer { self.isApplyingSelection = false }

        self.persistSelection(profile)
        self.phase = .ready(profile)
        self.statusLine = "Connected to \(profile.displayName)."
    }

    func clearProfileSelection() {
        self.clearSelection()
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
        guard let selectedID = self.defaults.string(forKey: browserSelectedChromeProfileIDKey) else {
            return nil
        }
        return profiles.first(where: { $0.directoryName == selectedID })
    }

    private func persistSelection(_ profile: ChromeProfileCandidate) {
        self.defaults.set(profile.directoryName, forKey: browserSelectedChromeProfileIDKey)
        self.defaults.set(profile.displayName, forKey: browserSelectedChromeProfileNameKey)
    }

    private func clearSelection() {
        self.defaults.removeObject(forKey: browserSelectedChromeProfileIDKey)
        self.defaults.removeObject(forKey: browserSelectedChromeProfileNameKey)
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
