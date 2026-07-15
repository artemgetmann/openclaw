import SwiftUI

/// Consumer-safe presentation for the one gateway recovery incident exposed by
/// the app. Keep process, service, launchd, and port details in diagnostics; the
/// user only needs to understand the impact and the single recovery action.
struct GatewayRecoveryIncident: Equatable, Sendable {
    let title: String
    let message: String
    let actionTitle: String

    static func offline(appName: String) -> Self {
        Self(
            title: "\(appName) needs a restart",
            message: "\(appName) could not reconnect. Restart it to restore AI access.",
            actionTitle: "Restart \(appName)")
    }
}

/// Tracks evidence and notification ownership independently from SwiftUI so
/// periodic reconciliation can be tested without waiting for its 60-second loop.
/// A healthy RPC resets the whole incident epoch; repeated failures inside the
/// same epoch keep the card visible but never enqueue another notification.
struct GatewayRecoveryIncidentTracker {
    static let unverifiableCheckLimit = 2

    private(set) var consecutiveUnverifiableChecks = 0
    private(set) var isIncidentActive = false
    private var notificationSentForCurrentIncident = false

    /// Returns true once service state has stayed unknown for enough consecutive
    /// checks to justify a bounded live-health verification. Unknown is never
    /// treated as proof that the service is missing.
    mutating func recordServiceObservation(_ isLoaded: Bool?) -> Bool {
        guard isLoaded == nil else {
            self.consecutiveUnverifiableChecks = 0
            return false
        }

        self.consecutiveUnverifiableChecks += 1
        return self.consecutiveUnverifiableChecks >= Self.unverifiableCheckLimit
    }

    /// Activates the shared incident and returns whether this incident epoch owns
    /// the notification. Repeated 60-second checks therefore stay silent.
    mutating func recordUnavailable() -> Bool {
        self.isIncidentActive = true
        guard !self.notificationSentForCurrentIncident else { return false }
        self.notificationSentForCurrentIncident = true
        return true
    }

    /// Live health is stronger evidence than local service inspection. It clears
    /// both the UI state and notification dedupe so a later real outage can alert.
    mutating func recordHealthy() {
        self.consecutiveUnverifiableChecks = 0
        self.isIncidentActive = false
        self.notificationSentForCurrentIncident = false
    }

    /// Intentional stop/remote transitions are not recovery incidents.
    mutating func reset() {
        self.recordHealthy()
    }
}

/// The same card is embedded on Home and AI Access. Keeping one view prevents
/// copy or action drift between surfaces during an incident.
struct GatewayRecoveryIncidentCard: View {
    let incident: GatewayRecoveryIncident
    let restart: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text(self.incident.title)
                    .font(.headline)
            }

            Text(self.incident.message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // One incident, one decision. Do not add Retry or expose repair
            // mechanics here; restart is the only consumer recovery path.
            Button(self.incident.actionTitle) {
                self.restart()
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.orange.opacity(0.10)))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.orange.opacity(0.35), lineWidth: 1))
    }
}
