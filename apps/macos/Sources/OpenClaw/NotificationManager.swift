import Foundation
import OpenClawIPC
import Security
import UserNotifications

@MainActor
struct NotificationManager {
    static let gatewayRecoveryCategoryIdentifier = "ai.jarvis.gateway-recovery"
    static let gatewayRecoveryRestartActionIdentifier = "ai.jarvis.gateway-recovery.restart"
    private let logger = Logger(subsystem: "ai.openclaw", category: "notifications")

    private static let hasTimeSensitiveEntitlement: Bool = {
        guard let task = SecTaskCreateFromSelf(nil) else { return false }
        let key = "com.apple.developer.usernotifications.time-sensitive" as CFString
        guard let val = SecTaskCopyValueForEntitlement(task, key, nil) else { return false }
        return (val as? Bool) == true
    }()

    func send(
        title: String,
        body: String,
        sound: String?,
        priority: NotificationPriority? = nil,
        identifier: String? = nil,
        categoryIdentifier: String? = nil) async -> Bool
    {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings()
        if status.authorizationStatus == .notDetermined {
            let granted = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            if granted != true {
                self.logger.warning("notification permission denied (request)")
                return false
            }
        } else if status.authorizationStatus != .authorized {
            self.logger.warning("notification permission denied status=\(status.authorizationStatus.rawValue)")
            return false
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let categoryIdentifier {
            content.categoryIdentifier = categoryIdentifier
        }
        if let soundName = sound, !soundName.isEmpty {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(soundName))
        }

        // Set interruption level based on priority
        if let priority {
            switch priority {
            case .passive:
                content.interruptionLevel = .passive
            case .active:
                content.interruptionLevel = .active
            case .timeSensitive:
                if Self.hasTimeSensitiveEntitlement {
                    content.interruptionLevel = .timeSensitive
                } else {
                    self.logger.debug(
                        "time-sensitive notification requested without entitlement; falling back to active")
                    content.interruptionLevel = .active
                }
            }
        }

        // Most notifications are independent events and keep the UUID default.
        // Recovery incidents supply a stable identifier as a second dedupe layer,
        // so Notification Center replaces stale delivery instead of stacking it.
        let req = UNNotificationRequest(
            identifier: identifier ?? UUID().uuidString,
            content: content,
            trigger: nil)
        do {
            try await center.add(req)
            self.logger.debug("notification queued")
            return true
        } catch {
            self.logger.error("notification send failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Register one consumer recovery action. Category registration is separate
    /// from authorization: configuring the action must not prompt the user.
    static func configureGatewayRecoveryActions(appName: String) {
        let center = UNUserNotificationCenter.current()
        center.delegate = GatewayRecoveryNotificationResponseHandler.shared
        center.setNotificationCategories([self.gatewayRecoveryCategory(appName: appName)])
    }

    static func gatewayRecoveryCategory(appName: String) -> UNNotificationCategory {
        let restart = UNNotificationAction(
            identifier: self.gatewayRecoveryRestartActionIdentifier,
            title: "Restart \(appName)",
            options: [.foreground])
        return UNNotificationCategory(
            identifier: self.gatewayRecoveryCategoryIdentifier,
            actions: [restart],
            intentIdentifiers: [],
            options: [])
    }
}

enum GatewayRecoveryNotificationRoute: Equatable {
    case restart

    @MainActor
    static func route(actionIdentifier: String) -> Self? {
        actionIdentifier == NotificationManager.gatewayRecoveryRestartActionIdentifier ? .restart : nil
    }
}

/// Notification actions arrive outside SwiftUI. Route the single recovery action
/// back through the same managed restart used by both in-app incident cards.
private final class GatewayRecoveryNotificationResponseHandler: NSObject, UNUserNotificationCenterDelegate,
    @unchecked Sendable
{
    static let shared = GatewayRecoveryNotificationResponseHandler()

    func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse) async
    {
        let actionIdentifier = response.actionIdentifier
        let route = await MainActor.run {
            GatewayRecoveryNotificationRoute.route(actionIdentifier: actionIdentifier)
        }
        guard route == .restart else {
            return
        }
        await MainActor.run {
            DebugActions.restartGateway()
        }
    }
}
