import AppKit

/// Central manager for Dock icon visibility.
/// Shows the Dock icon while any windows are visible, regardless of user preference.
final class DockIconManager: NSObject, @unchecked Sendable {
    static let shared = DockIconManager()

    private var windowsObservation: NSKeyValueObservation?
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
        NotificationCenter.default.removeObserver(self)
    }

    func updateDockVisibility() {
        Task { @MainActor in
            guard NSApp != nil else {
                self.logger.warning("NSApp not ready, skipping Dock visibility update")
                return
            }

            let userWantsDockHidden = !UserDefaults.standard.bool(forKey: showDockIconKey)
            let visibleWindows = NSApp?.windows.filter { window in
                window.isVisible &&
                    window.frame.width > 1 &&
                    window.frame.height > 1 &&
                    !window.isKind(of: NSPanel.self) &&
                    "\(type(of: window))" != "NSPopupMenuWindow" &&
                    window.contentViewController != nil
            } ?? []

            let hasVisibleWindows = !visibleWindows.isEmpty
            if Self.shouldUseRegularActivationPolicy(
                isConsumer: AppFlavor.current.isConsumer,
                userWantsDockHidden: userWantsDockHidden,
                hasVisibleWindows: hasVisibleWindows)
            {
                NSApp?.setActivationPolicy(.regular)
            } else {
                NSApp?.setActivationPolicy(.accessory)
            }
        }
    }

    static func shouldUseRegularActivationPolicy(
        isConsumer: Bool,
        userWantsDockHidden: Bool,
        hasVisibleWindows: Bool)
        -> Bool
    {
        // Consumer packages are first-run window apps, not background menu-bar
        // agents. Keeping them regular prevents Stage Manager from treating the
        // onboarding surface as a hidden side-strip thumbnail when Dock hiding is
        // still at its default.
        isConsumer || !userWantsDockHidden || hasVisibleWindows
    }

    @MainActor
    func temporarilyShowDock() {
        guard NSApp != nil else {
            self.logger.warning("NSApp not ready, cannot show Dock icon")
            return
        }
        NSApp.setActivationPolicy(.regular)
    }

    @MainActor
    func bringAppForward() {
        // LSUIElement/menu-bar launches can create windows without making the app
        // the active Stage Manager set. Promote the app and all of its windows in
        // one place before callers order first-run or settings surfaces.
        self.temporarilyShowDock()
        NSApp.unhide(nil)
        _ = NSRunningApplication.current.activate(options: [
            .activateAllWindows,
        ])
        NSApp.activate(ignoringOtherApps: true)
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
}
