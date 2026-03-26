import AppKit
import ApplicationServices

/// Central manager for Dock icon visibility.
/// Shows the Dock icon while any windows are visible, regardless of user preference.
final class DockIconManager: NSObject, @unchecked Sendable {
    static let shared = DockIconManager()

    private var windowsObservation: NSKeyValueObservation?
    private var visibilityHoldUntil: Date?
    private var visibilityHoldResetTask: Task<Void, Never>?
    private let logger = Logger(subsystem: "ai.openclaw", category: "DockIconManager")

    override private init() {
        super.init()
        self.setupObservers()
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    deinit {
        self.windowsObservation?.invalidate()
        self.visibilityHoldResetTask?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    func updateDockVisibility() {
        Task { @MainActor in
            guard NSApp != nil else {
                self.logger.warning("NSApp not ready, skipping Dock visibility update")
                return
            }

            let userWantsDockIcon = UserDefaults.standard.bool(forKey: showDockIconKey)
            let visibleWindows = NSApp?.windows.filter { window in
                window.isVisible &&
                    window.frame.width > 1 &&
                    window.frame.height > 1 &&
                    !window.isKind(of: NSPanel.self) &&
                    "\(type(of: window))" != "NSPopupMenuWindow" &&
                    window.contentViewController != nil
            } ?? []

            let hasVisibleWindows = !visibleWindows.isEmpty
            let shouldKeepConsumerDockVisible = self.shouldKeepConsumerDockVisible()
            let hasVisibilityHold = self.hasActiveVisibilityHold()
            if Self.shouldUseRegularActivationPolicy(
                userWantsDockIcon: userWantsDockIcon,
                hasVisibleWindows: hasVisibleWindows,
                shouldKeepConsumerDockVisible: shouldKeepConsumerDockVisible,
                hasVisibilityHold: hasVisibilityHold)
            {
                NSApp?.setActivationPolicy(.regular)
            } else {
                NSApp?.setActivationPolicy(.accessory)
            }
        }
    }

    func temporarilyShowDock(holdFor seconds: TimeInterval = 10) {
        Task { @MainActor in
            guard NSApp != nil else {
                self.logger.warning("NSApp not ready, cannot show Dock icon")
                return
            }
            // Keep the Dock icon alive briefly after surfacing Settings so a
            // first-run user can still relaunch the app if they accidentally
            // close the window or macOS steals focus into System Settings.
            self.visibilityHoldUntil = Date().addingTimeInterval(seconds)
            self.visibilityHoldResetTask?.cancel()
            self.visibilityHoldResetTask = Task { [weak self] in
                let delay = UInt64(max(seconds, 0) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: delay)
                await MainActor.run {
                    self?.updateDockVisibility()
                }
            }
            NSApp.setActivationPolicy(.regular)
        }
    }

    static func shouldUseRegularActivationPolicy(
        userWantsDockIcon: Bool,
        hasVisibleWindows: Bool,
        shouldKeepConsumerDockVisible: Bool,
        hasVisibilityHold: Bool) -> Bool
    {
        userWantsDockIcon || hasVisibleWindows || shouldKeepConsumerDockVisible || hasVisibilityHold
    }

    static func shouldKeepConsumerDockVisible(
        isConsumer: Bool,
        onboardingPending: Bool,
        accessibilityGranted: Bool,
        screenRecordingGranted: Bool) -> Bool
    {
        guard isConsumer else { return false }

        // Consumer first-run is not actually done until the app is reachable
        // again and the two most failure-prone permissions have a clear
        // recovery path. Hiding the Dock icon sooner strands users.
        return onboardingPending || !accessibilityGranted || !screenRecordingGranted
    }

    private func setupObservers() {
        Task { @MainActor in
            guard let app = NSApp else {
                self.logger.warning("NSApp not ready, delaying Dock observers")
                try? await Task.sleep(for: .milliseconds(200))
                self.setupObservers()
                return
            }

            self.windowsObservation = app.observe(\.windows, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(50))
                    self?.updateDockVisibility()
                }
            }

            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.didBecomeKeyNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.didResignKeyNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.willCloseNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.dockPreferenceChanged),
                name: UserDefaults.didChangeNotification,
                object: nil)
        }
    }

    @objc
    private func windowVisibilityChanged(_: Notification) {
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    @objc
    private func dockPreferenceChanged(_ notification: Notification) {
        guard let userDefaults = notification.object as? UserDefaults,
              userDefaults == UserDefaults.standard
        else { return }

        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    @MainActor
    private func shouldKeepConsumerDockVisible() -> Bool {
        Self.shouldKeepConsumerDockVisible(
            isConsumer: AppFlavor.current.isConsumer,
            onboardingPending: self.isConsumerOnboardingPending(),
            accessibilityGranted: AXIsProcessTrusted(),
            screenRecordingGranted: ScreenRecordingProbe.isAuthorized())
    }

    private func isConsumerOnboardingPending() -> Bool {
        let seenVersion = UserDefaults.standard.integer(forKey: onboardingVersionKey)
        let onboardingSeen = UserDefaults.standard.bool(forKey: onboardingSeenKey)
        return seenVersion < currentOnboardingVersion || !onboardingSeen
    }

    private func hasActiveVisibilityHold(now: Date = Date()) -> Bool {
        guard let visibilityHoldUntil = self.visibilityHoldUntil else { return false }
        if visibilityHoldUntil <= now {
            self.visibilityHoldUntil = nil
            return false
        }
        return true
    }
}
