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
        self.open(tab: tab, revealPolicy: .whenNoVisibleContentWindow)
    }

    func reveal(tab: SettingsTab? = nil) {
        self.open(tab: tab, revealPolicy: .always)
    }

    private func open(tab: SettingsTab?, revealPolicy: RevealPolicy) {
        // Menu/status refreshes should not steal focus from another app just
        // because Settings already exists. Explicit Dock/app activation is
        // different: the user asked for the app, so re-raise the window even if
        // AppKit says a content window is technically visible.
        let shouldRevealWindow = Self.shouldRevealContentWindow(
            hasVisibleContentWindow: Self.hasVisibleContentWindow(),
            forceReveal: revealPolicy == .always)
        if !shouldRevealWindow {
            self.selectTab(tab)
            return
        }

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

    // Opening Settings is async when SwiftUI has to create the scene. Queue the
    // tab switch so the new SettingsRootView can subscribe before selection.
    private func selectTab(_ tab: SettingsTab?) {
        guard let tab else { return }
        SettingsTabRouter.request(tab)
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    // Accessory apps can activate before SwiftUI's Settings window is frontmost.
    // Re-focus over a few run-loop ticks so left-click/menu actions recover from
    // stale hidden windows without needing a second user click.
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

    static func shouldRevealContentWindow(hasVisibleContentWindow: Bool) -> Bool {
        self.shouldRevealContentWindow(
            hasVisibleContentWindow: hasVisibleContentWindow,
            forceReveal: false)
    }

    static func shouldRevealContentWindow(hasVisibleContentWindow: Bool, forceReveal: Bool) -> Bool {
        forceReveal || !hasVisibleContentWindow
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

        // SwiftUI Settings scenes are real windows, but AppKit does not promise
        // a contentViewController. Content view presence is enough to re-raise.
        return hasContentView || hasContentViewController
    }
}

private enum RevealPolicy {
    case whenNoVisibleContentWindow
    case always
}
