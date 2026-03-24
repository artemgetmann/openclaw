import SwiftUI

struct BrowserSetupCardContent: View {
    @Bindable var model: BrowserSetupModel
    let presentation: BrowserSetupPresentation

    enum BrowserSetupPresentation {
        case onboarding
        case settings
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header

            switch self.model.phase {
            case .idle, .checking:
                self.loadingState
            case .chromeMissing:
                self.chromeMissingState
            case .noProfiles:
                self.noProfilesState
            case let .confirm(profile):
                self.confirmState(profile: profile)
            case let .choose(profiles):
                self.chooseState(profiles: profiles)
            case let .ready(profile):
                self.readyState(profile: profile)
            case let .failed(message):
                self.failureState(message: message)
            }
        }
        .task {
            await self.model.refreshIfNeeded()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(self.presentation == .onboarding ? "Connect your Chrome" : "Browser")
                .font(.headline)
            Text(
                "OpenClaw uses a separate copy of your Chrome profile so it can work with your sessions without touching your active browsing.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text(self.model.statusLine ?? "Checking Chrome on this Mac…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var chromeMissingState: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.callout(
                title: "Google Chrome required",
                body: "This MVP expects Google Chrome to already be installed on this Mac before browser setup can continue.")

            HStack(spacing: 10) {
                Button("Install Chrome") { self.model.openChromeDownloadPage() }
                    .buttonStyle(.borderedProminent)
                Button("Check Again") {
                    Task { await self.model.refresh() }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var noProfilesState: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.callout(
                title: "Open Chrome once first",
                body: "Open Google Chrome on this Mac so OpenClaw can detect a real profile without asking you for browser internals.")

            Button("Check Again") {
                Task { await self.model.refresh() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func confirmState(profile: ChromeProfileCandidate) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            self.callout(
                title: "We found your Chrome profile",
                body: "OpenClaw will use a separate copy of this profile. Your regular Chrome windows stay untouched.")

            self.profileCard(profile, selected: true, action: nil)

            HStack(spacing: 10) {
                Button("Use This Profile") {
                    Task { await self.model.chooseProfile(profile) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.model.isApplyingSelection)

                Button("Check Again") {
                    Task { await self.model.refresh() }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func chooseState(profiles: [ChromeProfileCandidate]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            self.callout(
                title: "Choose a Chrome profile",
                body: "Pick the Chrome profile OpenClaw should copy into its own browser window. You should not need to inspect any Chrome settings or filesystem paths.")

            ForEach(profiles) { profile in
                self.profileCard(profile, selected: false) {
                    Task { await self.model.chooseProfile(profile) }
                }
            }

            Button("Check Again") {
                Task { await self.model.refresh() }
            }
            .buttonStyle(.bordered)
        }
    }

    private func readyState(profile: ChromeProfileCandidate) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            self.callout(
                title: "Chrome connected",
                body: "OpenClaw can now use \(profile.displayName) for browser tasks on this Mac. If a site needs your account, OpenClaw will open the page and wait for you to sign in.")

            self.profileCard(profile, selected: true, action: nil)

            HStack(spacing: 10) {
                Button("Choose Another Profile") {
                    self.model.clearProfileSelection()
                }
                .buttonStyle(.bordered)

                Button("Refresh Status") {
                    Task { await self.model.refresh() }
                }
                .buttonStyle(.bordered)
            }

            Divider()
                .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 8) {
                Text("If a website needs extra help")
                    .font(.subheadline.weight(.semibold))
                ForEach(BrowserRuntimeFailureTemplateKind.allCases, id: \.self) { kind in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(kind.title)
                            .font(.caption.weight(.semibold))
                        Text(kind.body)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func failureState(message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            self.callout(title: "Browser setup problem", body: message)
            Button("Try Again") {
                Task { await self.model.refresh() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func callout(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func profileCard(
        _ profile: ChromeProfileCandidate,
        selected: Bool,
        action: (() -> Void)?) -> some View
    {
        Group {
            if let action {
                Button(action: action) {
                    self.profileCardLabel(profile: profile, selected: selected)
                }
                .buttonStyle(.plain)
            } else {
                self.profileCardLabel(profile: profile, selected: selected)
            }
        }
    }

    private func profileCardLabel(profile: ChromeProfileCandidate, selected: Bool) -> some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
                    .frame(width: 36, height: 36)
                Text(profile.initials)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(selected ? Color.accentColor : .primary)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(profile.displayName)
                    .font(.callout.weight(.semibold))
                if let subtitle = self.profileSubtitle(profile) {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 0)
            SelectionStateIndicator(selected: selected)
        }
        .openClawSelectableRowChrome(selected: selected)
    }

    private func profileSubtitle(_ profile: ChromeProfileCandidate) -> String? {
        var parts: [String] = []
        if let subtitle = profile.subtitle {
            parts.append(subtitle)
        }
        if let lastUsed = profile.lastUsedDescription {
            parts.append("Used \(lastUsed)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
