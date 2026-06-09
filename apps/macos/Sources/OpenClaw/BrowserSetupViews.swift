import AppKit
import SwiftUI

struct BrowserSetupCardContent: View {
    @Bindable var model: BrowserSetupModel
    let presentation: BrowserSetupPresentation
    private let gatewayManager = GatewayProcessManager.shared

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
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await self.model.retryTransientFailureIfNeeded() }
        }
        .onChange(of: self.gatewayManager.status) { _, status in
            Task { await self.model.retryTransientFailureAfterGatewayStatusChange(status) }
        }
    }

    @ViewBuilder
    private var header: some View {
        if self.presentation == .settings {
            VStack(alignment: .leading, spacing: 4) {
                Text("Choose Your Main Chrome Account")
                    .font(.headline)
                Text("Jarvis will use this Chrome browser, so you don’t have to log in everywhere again.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
                body: "Install Google Chrome on this Mac, then come back to finish browser setup.")

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
                body: "Open Chrome, sign in to the profile you want \(AppFlavor.current.appName) to use, then click Check Again.")

            HStack(spacing: 10) {
                Button("Open Chrome") {
                    self.model.openChromeApp()
                }
                .buttonStyle(.borderedProminent)

                Button("Check Again") {
                    Task { await self.model.refresh() }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func confirmState(profile: ChromeProfileCandidate) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Use \(profile.displayName)?")
                .font(.subheadline.weight(.semibold))

            self.profileCard(profile, selected: true, action: nil)

            HStack(spacing: 10) {
                Button("Use This Account") {
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
                body: "\(AppFlavor.current.appName) will use \(profile.displayName) when browser tasks need your signed-in sites.")

            self.profileCard(profile, selected: true, action: nil)

            HStack(spacing: 10) {
                Button("Choose Another Account") {
                    self.model.clearProfileSelection()
                }
                .buttonStyle(.bordered)

                Button("Check Again") {
                    Task { await self.model.refresh() }
                }
                .buttonStyle(.bordered)
            }

            if self.presentation == .settings {
                Divider()
                    .padding(.vertical, 2)

                DisclosureGroup("If a website needs extra help") {
                    VStack(alignment: .leading, spacing: 8) {
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
                    .padding(.top, 6)
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
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
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
