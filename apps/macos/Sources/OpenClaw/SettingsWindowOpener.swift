import AppKit
import SwiftUI

@objc
private protocol SettingsWindowMenuActions {
    @objc(showSettingsWindow:)
    optional func showSettingsWindow(_ sender: Any?)

    @objc(showPreferencesWindow:)
    optional func showPreferencesWindow(_ sender: Any?)
}

@MainActor
final class SettingsWindowOpener {
    static let shared = SettingsWindowOpener()

    private var openSettingsAction: OpenSettingsAction?

    func register(openSettings: OpenSettingsAction) {
        self.openSettingsAction = openSettings
    }

    func open(tab: SettingsTab? = nil) {
        DockIconManager.shared.temporarilyShowDock()
        NSApp.activate(ignoringOtherApps: true)
        if let openSettingsAction {
            openSettingsAction()
            self.selectTab(tab)
            self.ensureVisibleContentWindow()
            return
        }

        // Fallback path: mimic the built-in Settings menu item action.
        let didOpen = NSApp.sendAction(#selector(SettingsWindowMenuActions.showSettingsWindow(_:)), to: nil, from: nil)
        if !didOpen {
            _ = NSApp.sendAction(#selector(SettingsWindowMenuActions.showPreferencesWindow(_:)), to: nil, from: nil)
        }
        self.selectTab(tab)
        self.ensureVisibleContentWindow()
    }

    func hideContentWindows() {
        for window in Self.contentWindows() {
            window.orderOut(nil)
        }
    }

    // Non-trivial: opening Settings is asynchronous when SwiftUI has to create
    // the scene. Post the tab selection on the next run loop so the new window
    // can subscribe before we ask it to switch tabs.
    private func selectTab(_ tab: SettingsTab?) {
        guard let tab else { return }
        SettingsTabRouter.request(tab)
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    // Menu-bar accessory apps can successfully create a Settings window and
    // still leave it effectively hidden when activation policy churn races with
    // SwiftUI scene creation. Re-assert visibility a few times on the next run
    // loop ticks so the real content window stays in front long enough for the
    // shell to stabilize.
    private func ensureVisibleContentWindow() {
        for attempt in 0..<4 {
            DispatchQueue.main.asyncAfter(deadline: .now() + (0.12 * Double(attempt))) {
                Self.focusVisibleContentWindow()
            }
        }
    }

    @MainActor
    private static func focusVisibleContentWindow() {
        DockIconManager.shared.temporarilyShowDock()
        NSApp.activate(ignoringOtherApps: true)
        guard let window = self.contentWindows().first else { return }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
    }

    private static func contentWindows() -> [NSWindow] {
        NSApp.windows.filter { window in
            self.isContentWindowCandidate(window)
        }
    }

    static func hasVisibleContentWindow() -> Bool {
        self.contentWindows().contains { $0.isVisible }
    }

    static func hasReplacementContentWindow() -> Bool {
        return self.contentWindows().contains { window in
            guard !self.isOnboardingWindow(window) else { return false }
            return window.isVisible
        }
    }

    static func isContentWindowCandidate(_ window: NSWindow) -> Bool {
        self.isContentWindowCandidate(
            frameWidth: window.frame.width,
            frameHeight: window.frame.height,
            isPanel: window.isKind(of: NSPanel.self),
            className: "\(type(of: window))",
            hasContentView: window.contentView != nil,
            hasContentViewController: window.contentViewController != nil)
    }

    static func isContentWindowCandidate(
        frameWidth: CGFloat,
        frameHeight: CGFloat,
        isPanel: Bool,
        className: String,
        hasContentView: Bool,
        hasContentViewController: Bool
    ) -> Bool {
        guard frameWidth > 1, frameHeight > 1 else { return false }
        guard !isPanel else { return false }
        guard className != "NSPopupMenuWindow" else { return false }

        // SwiftUI Settings scenes are real app windows, but AppKit does not
        // guarantee they have a contentViewController. During finish handoff we
        // only care whether a real replacement surface exists, and excluding
        // content-view-only windows is what makes onboarding think Settings is
        // "missing" and pop itself back on screen.
        return hasContentView || hasContentViewController
    }

    static func isOnboardingWindow(_ window: NSWindow) -> Bool {
        window.identifier == OnboardingController.windowIdentifier
    }
}
