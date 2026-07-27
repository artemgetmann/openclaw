import SwiftUI

/// Consumer-safe presentation for the recovery incident exposed by the app.
/// Keep process, service, launchd, provider, poll, and port details in diagnostics; the
/// user only needs to understand the impact and the single recovery action.
struct GatewayRecoveryIncident: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case gatewayOffline
        case telegramOffline
    }

    let kind: Kind
    let title: String
    let message: String
    let actionTitle: String

    static func offline(appName: String) -> Self {
        Self(
            kind: .gatewayOffline,
            title: "\(appName) needs a restart",
            message: "\(appName) could not reconnect. Restart it to restore AI access.",
            actionTitle: "Restart \(appName)")
    }

    static func telegramOffline(appName: String) -> Self {
        Self(
            kind: .telegramOffline,
            title: "Telegram is offline",
            message: "\(appName) could not reconnect to Telegram automatically.",
            actionTitle: "Restart \(appName)")
    }
}

/// Consumer monitoring observes the gateway-owned recovery contract, not
/// Telegram's generic `running` flag. These values deliberately mirror only the
/// evidence needed to decide whether manual recovery is justified.
struct TelegramRecoveryObservation: Equatable, Sendable {
    enum Phase: String, Codable, Equatable, Sendable {
        case providerRestart = "provider-restart"
        case gatewayRestartRequested = "gateway-restart-requested"
        case exhausted
    }

    let phase: Phase?
    let providerRestartAttempts: Int?
    let updatedAt: Double?
    let lastPollSuccessAt: Double?
    let lastPollOutcome: String?

    init(
        phase: Phase? = nil,
        providerRestartAttempts: Int? = nil,
        updatedAt: Double? = nil,
        lastPollSuccessAt: Double? = nil,
        lastPollOutcome: String? = nil)
    {
        self.phase = phase
        self.providerRestartAttempts = providerRestartAttempts
        self.updatedAt = updatedAt
        self.lastPollSuccessAt = lastPollSuccessAt
        self.lastPollOutcome = lastPollOutcome
    }
}

/// Holds the incident timestamp across snapshots because the gateway removes
/// `telegramRecovery` once transport recovery is proven. Absence alone is not
/// enough to clear the card: the app still requires a newer, recent successful
/// getUpdates completion as direct proof that Telegram long-polling works again.
struct TelegramRecoveryIncidentTracker {
    enum Transition: Equatable {
        case unchanged
        case present(shouldNotify: Bool)
        case clear
    }

    static let pollingProofFreshnessMs: Double = 180_000

    private(set) var incidentUpdatedAt: Double?
    private var notificationSentForCurrentIncident = false

    var isIncidentActive: Bool {
        self.incidentUpdatedAt != nil
    }

    mutating func observe(_ observation: TelegramRecoveryObservation, nowMs: Double) -> Transition {
        let observedExhaustedAt = observation.phase == .exhausted
            ? observation.updatedAt.flatMap { $0.isFinite ? $0 : nil }
            : nil
        let recoveryBoundary = [self.incidentUpdatedAt, observedExhaustedAt]
            .compactMap(\.self)
            .max()

        if let recoveryBoundary,
           let successAt = observation.lastPollSuccessAt,
           successAt > recoveryBoundary
        {
            // `lastPollOutcome` may already be `in-flight` for the next long
            // poll. The dedicated success timestamp is deliberately durable.
            let age = nowMs - successAt
            if age >= 0, age <= Self.pollingProofFreshnessMs {
                self.incidentUpdatedAt = nil
                self.notificationSentForCurrentIncident = false
                return .clear
            }
        }

        // Provider and gateway restart phases are still automatic recovery.
        // Only the gateway's terminal exhaustion state authorizes user-facing UI.
        guard let observedExhaustedAt else { return .unchanged }

        if let existingIncidentUpdatedAt = self.incidentUpdatedAt {
            if observedExhaustedAt > existingIncidentUpdatedAt {
                // A newer terminal recovery timestamp is stronger than the retained
                // local boundary. Keep the incident visible and require proof newer
                // than the latest gateway-owned exhaustion state.
                self.incidentUpdatedAt = observedExhaustedAt
            }
        } else {
            self.incidentUpdatedAt = observedExhaustedAt
        }
        let shouldNotify = !self.notificationSentForCurrentIncident
        self.notificationSentForCurrentIncident = true
        return .present(shouldNotify: shouldNotify)
    }

    mutating func reset() {
        self.incidentUpdatedAt = nil
        self.notificationSentForCurrentIncident = false
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

    /// The external helper already owns native notification delivery. Import
    /// its durable receipt into the existing card without enqueueing a duplicate.
    mutating func recordExternallyNotifiedUnavailable() {
        self.isIncidentActive = true
        self.notificationSentForCurrentIncident = true
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
