import AppKit
import CoreGraphics
import OpenClawIPC

/// This is intentionally a compact port of the MIT-licensed Open Computer Use
/// permission accessory-panel pattern. We keep the useful behavior (live
/// System Settings window tracking and a draggable app tile) without importing
/// its onboarding app or animation system.
@MainActor
final class ConsumerPermissionAccessoryPanelController {
    private enum Layout {
        // Keep the helper visually subordinate to System Settings. It should
        // feel like one compact instruction attached to Apple's list, not a
        // second onboarding card competing for attention.
        static let panelSize = CGSize(width: 500, height: 112)
        static let trackingInterval: TimeInterval = 0.15
        /// Deep links switch an already-open Settings window asynchronously.
        /// Wait briefly before treating its current title as the requested pane.
        static let paneSettleDelay: TimeInterval = 0.45
    }

    private var panel: NSPanel?
    private var capability: Capability?
    private var trackingTimer: Timer?
    private var workspaceObserver: NSObjectProtocol?
    private var orderedWindowNumber: Int?
    private var expectedSettingsWindowTitle: String?
    private var presentationNotBefore = Date.distantPast
    private var hasPresentedPanel = false

    func show(for capability: Capability) {
        guard ConsumerPermissionRecoverySupport.requiresSettingsRecovery(capability) else { return }

        self.capability = capability
        self.expectedSettingsWindowTitle = nil
        self.presentationNotBefore = Date().addingTimeInterval(Layout.paneSettleDelay)
        self.hasPresentedPanel = false
        let panel = self.panel ?? self.makePanel()
        self.panel = panel
        // The same controller can move from Accessibility to Screen Recording
        // without rebuilding its tracking machinery. Replace only the content
        // so its title and drag instruction always describe the pane in front
        // of the user, never the one they visited previously.
        panel.contentView = ConsumerPermissionAccessoryPanelView(capability: capability)
        self.startTracking()
        self.updateVisibilityAndPosition()
    }

    func hide(for capability: Capability) {
        guard self.capability == capability else { return }
        self.hide()
    }

    func hide() {
        self.trackingTimer?.invalidate()
        self.trackingTimer = nil
        if let workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver)
            self.workspaceObserver = nil
        }
        self.panel?.orderOut(nil)
        self.capability = nil
        self.orderedWindowNumber = nil
        self.expectedSettingsWindowTitle = nil
        self.presentationNotBefore = .distantPast
        self.hasPresentedPanel = false
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Layout.panelSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .transient, .fullScreenAuxiliary]
        panel.animationBehavior = .none
        return panel
    }

    private func startTracking() {
        if self.workspaceObserver == nil {
            // App-activation notifications make the panel disappear promptly;
            // the timer below also catches window moves and resizes, for which
            // another process does not send us AppKit window notifications.
            self.workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification,
                object: nil,
                queue: .main)
            { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.updateVisibilityAndPosition()
                }
            }
        }

        guard self.trackingTimer == nil else { return }
        let timer = Timer(timeInterval: Layout.trackingInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.updateVisibilityAndPosition()
            }
        }
        timer.tolerance = 0.03
        RunLoop.main.add(timer, forMode: .common)
        self.trackingTimer = timer
    }

    private func updateVisibilityAndPosition() {
        guard let panel, self.capability != nil else { return }
        guard self.isSystemSettingsFrontmost else {
            // Once the helper has been shown, leaving Settings ends this help
            // session. A later visit should require a fresh click in Jarvis,
            // rather than resurrecting stale instructions over another pane.
            panel.orderOut(nil)
            self.orderedWindowNumber = nil
            if self.hasPresentedPanel {
                self.hide()
            }
            return
        }
        guard Date() >= self.presentationNotBefore else {
            panel.orderOut(nil)
            return
        }
        guard let context = self.systemSettingsWindowContext() else {
            panel.orderOut(nil)
            self.orderedWindowNumber = nil
            return
        }

        let observedTitle = ConsumerPermissionAccessoryPanelPane.normalizedTitle(context.windowTitle)
        if self.expectedSettingsWindowTitle == nil {
            // Capture the localized title reached by the deep link. Hard-coded
            // English titles would break on non-English Macs, while the title
            // may be absent entirely until Screen Recording is granted.
            self.expectedSettingsWindowTitle = observedTitle
        }
        guard ConsumerPermissionAccessoryPanelPane.matches(
            observedTitle: observedTitle,
            expectedTitle: self.expectedSettingsWindowTitle)
        else {
            panel.orderOut(nil)
            self.orderedWindowNumber = nil
            return
        }

        let frame = ConsumerPermissionAccessoryPanelLayout.frame(
            panelSize: panel.frame.size,
            systemSettingsFrame: context.frame,
            visibleScreenFrame: self.visibleScreenFrame(for: context.frame))
        panel.setFrame(frame, display: panel.isVisible)

        // `order(_:relativeTo:)` is deliberately window-number based instead
        // of activation based. It keeps the helper immediately below System
        // Settings while leaving Settings as the active app, so dragging still
        // lands in Apple's permission list and we never need Accessibility
        // permission merely to position our own UI.
        if self.orderedWindowNumber != context.windowNumber || !panel.isVisible {
            panel.order(.above, relativeTo: context.windowNumber)
            self.orderedWindowNumber = context.windowNumber
            self.hasPresentedPanel = true
        }
    }

    private var isSystemSettingsFrontmost: Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.systempreferences"
    }

    private func visibleScreenFrame(for frame: CGRect) -> CGRect {
        NSScreen.screens.first(where: { $0.visibleFrame.intersects(frame) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? frame
    }

    private func systemSettingsWindowContext() -> SystemSettingsWindowContext? {
        guard let settings = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.systempreferences"
        }) else {
            return nil
        }
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        // Settings can temporarily add normal-layer dialogs. Use its largest
        // normal window so the helper stays attached to the actual Settings
        // workspace rather than jumping under a confirmation dialog.
        var largestWindow: (context: SystemSettingsWindowContext, area: CGFloat)?
        for info in infos {
            guard
                let ownerPID = info[kCGWindowOwnerPID as String] as? Int32,
                ownerPID == settings.processIdentifier,
                let layer = info[kCGWindowLayer as String] as? Int,
                layer == 0,
                let windowNumber = info[kCGWindowNumber as String] as? Int,
                let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                let quartzBounds = CGRect(dictionaryRepresentation: boundsDictionary)
            else {
                continue
            }
            let frame = ConsumerPermissionAccessoryPanelLayout.appKitFrame(
                fromQuartzBounds: quartzBounds,
                screens: NSScreen.screens)
            let context = SystemSettingsWindowContext(
                frame: frame,
                windowNumber: windowNumber,
                windowTitle: info[kCGWindowName as String] as? String)
            let area = frame.width * frame.height
            if largestWindow.map({ area > $0.area }) ?? true {
                largestWindow = (context, area)
            }
        }
        return largestWindow?.context
    }

    private struct SystemSettingsWindowContext {
        let frame: CGRect
        let windowNumber: Int
        let windowTitle: String?
    }
}

/// Compares an observed Settings title with the localized title captured after
/// the deep link settles. CGWindow omits titles before Screen Recording access
/// on some Macs, so missing metadata must remain a valid fallback.
enum ConsumerPermissionAccessoryPanelPane {
    static func normalizedTitle(_ title: String?) -> String? {
        guard let title else { return nil }
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    static func matches(observedTitle: String?, expectedTitle: String?) -> Bool {
        guard let observedTitle, let expectedTitle else {
            // Never make the helper itself depend on Screen Recording access.
            return true
        }
        return observedTitle.caseInsensitiveCompare(expectedTitle) == .orderedSame
    }
}

/// Kept pure so the multi-display clamping behavior can be tested without
/// opening a panel or asking macOS for any permission.
enum ConsumerPermissionAccessoryPanelLayout {
    static func frame(
        panelSize: CGSize,
        systemSettingsFrame: CGRect,
        visibleScreenFrame: CGRect)
        -> CGRect
    {
        let horizontalInset: CGFloat = 16
        let bottomInset: CGFloat = 12
        let bottomOverlap: CGFloat = 6
        // System Settings has a persistent sidebar. Starting at the content
        // column (rather than centering below the whole window) visually ties
        // the tile to the privacy list the user must drop Jarvis into.
        let x = self.clamp(
            systemSettingsFrame.minX + self.contentLeadingInset(for: systemSettingsFrame.width),
            lower: visibleScreenFrame.minX + horizontalInset,
            upper: visibleScreenFrame.maxX - panelSize.width - horizontalInset)
        let y = max(
            visibleScreenFrame.minY + bottomInset,
            systemSettingsFrame.minY - panelSize.height + bottomOverlap)
        return CGRect(origin: CGPoint(x: x, y: y), size: panelSize)
    }

    static func appKitFrame(fromQuartzBounds bounds: CGRect, screens: [NSScreen]) -> CGRect {
        // Quartz uses the primary display's top-left as the global origin;
        // AppKit uses that display's bottom-left. The transform must therefore
        // use the primary display even when the window is on a monitor arranged
        // above or below it. Comparing raw Quartz bounds with AppKit screen
        // frames would mix coordinate spaces and can offset the panel by a
        // complete display height.
        let primaryScreen = screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.main
        guard let primaryScreen else { return bounds }
        return self.appKitFrame(
            fromQuartzBounds: bounds,
            primaryDisplayMaxY: primaryScreen.frame.maxY)
    }

    static func appKitFrame(fromQuartzBounds bounds: CGRect, primaryDisplayMaxY: CGFloat) -> CGRect {
        CGRect(
            x: bounds.minX,
            y: primaryDisplayMaxY - bounds.maxY,
            width: bounds.width,
            height: bounds.height)
    }

    static func contentLeadingInset(for settingsWidth: CGFloat) -> CGFloat {
        // Apple's current Privacy & Security window gives the sidebar roughly
        // 30% of the window. The previous 36% estimate pushed the helper visibly
        // to the right of the list on the compact Settings size used by most
        // people, which made an otherwise attached panel feel accidental.
        min(280, max(16, settingsWidth * 0.30))
    }

    private static func clamp(_ value: CGFloat, lower: CGFloat, upper: CGFloat) -> CGFloat {
        guard lower <= upper else { return lower }
        return min(max(value, lower), upper)
    }
}

enum ConsumerPermissionAccessoryPanelCopy {
    static func title(for capability: Capability) -> String {
        switch capability {
        case .accessibility:
            "Accessibility"
        case .screenRecording:
            "Screen & System Audio Recording"
        default:
            AppFlavor.current.appName
        }
    }

    static func instruction(for capability: Capability) -> String {
        switch capability {
        case .accessibility:
            "Drag Jarvis into this list"
        case .screenRecording:
            "Drag Jarvis into this list"
        default:
            "Drag Jarvis into this list"
        }
    }

    static let followUp = "Then turn it on."
}

@MainActor
private final class ConsumerPermissionAccessoryPanelView: NSView {
    private let capability: Capability

    init(capability: Capability) {
        self.capability = capability
        super.init(frame: .zero)
        self.configure()
    }

    override init(frame frameRect: NSRect) {
        self.capability = .accessibility
        super.init(frame: frameRect)
        self.configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    private func configure() {
        let material = NSVisualEffectView()
        material.translatesAutoresizingMaskIntoConstraints = false
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 14
        material.layer?.masksToBounds = true
        material.layer?.borderWidth = 0.5
        material.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.55).cgColor
        self.addSubview(material)

        let title = NSTextField(labelWithString: ConsumerPermissionAccessoryPanelCopy.title(for: self.capability))
        title.font = .systemFont(ofSize: 11.5, weight: .semibold)
        title.textColor = .secondaryLabelColor
        title.translatesAutoresizingMaskIntoConstraints = false

        let instruction = NSTextField(
            labelWithString: ConsumerPermissionAccessoryPanelCopy.instruction(for: self.capability))
        instruction.font = .systemFont(ofSize: 15, weight: .semibold)
        instruction.translatesAutoresizingMaskIntoConstraints = false

        let followUp = NSTextField(labelWithString: ConsumerPermissionAccessoryPanelCopy.followUp)
        followUp.font = .systemFont(ofSize: 12.5, weight: .regular)
        followUp.textColor = .secondaryLabelColor
        followUp.translatesAutoresizingMaskIntoConstraints = false

        let tile = ConsumerPermissionDraggableAppTile()
        tile.translatesAutoresizingMaskIntoConstraints = false

        material.addSubview(title)
        material.addSubview(instruction)
        material.addSubview(followUp)
        material.addSubview(tile)
        NSLayoutConstraint.activate([
            material.leadingAnchor.constraint(equalTo: self.leadingAnchor),
            material.trailingAnchor.constraint(equalTo: self.trailingAnchor),
            material.topAnchor.constraint(equalTo: self.topAnchor),
            material.bottomAnchor.constraint(equalTo: self.bottomAnchor),
            title.leadingAnchor.constraint(equalTo: material.leadingAnchor, constant: 18),
            title.topAnchor.constraint(equalTo: material.topAnchor, constant: 17),
            instruction.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            instruction.trailingAnchor.constraint(lessThanOrEqualTo: tile.leadingAnchor, constant: -18),
            instruction.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 7),
            followUp.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            followUp.topAnchor.constraint(equalTo: instruction.bottomAnchor, constant: 3),
            tile.trailingAnchor.constraint(equalTo: material.trailingAnchor, constant: -18),
            tile.centerYAnchor.constraint(equalTo: material.centerYAnchor),
            tile.widthAnchor.constraint(equalToConstant: 154),
            tile.heightAnchor.constraint(equalToConstant: 72),
        ])
    }
}

@MainActor
private final class ConsumerPermissionDraggableAppTile: NSView, NSDraggingSource {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        self.wantsLayer = true
        self.layer?.cornerRadius = 12
        self.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.88).cgColor
        self.layer?.borderWidth = 0.5
        self.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.7).cgColor
        self.toolTip = "Drag \(AppFlavor.current.appName) into System Settings"

        // Use real subviews instead of painting the icon and label in draw(_:).
        // The controller replaces panel content while the panel is already
        // visible when the user moves between permission rows. Auto Layout
        // reliably redraws these subviews after that replacement; a custom
        // draw pass can run while the new tile still has zero-sized bounds and
        // leave the tile blank until another invalidation happens.
        let icon = ProductAppIconImageView(size: 44)
        icon.translatesAutoresizingMaskIntoConstraints = false

        let label = NSTextField(labelWithString: AppFlavor.current.appName)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = .systemFont(ofSize: 14, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail

        self.addSubview(icon)
        self.addSubview(label)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: self.leadingAnchor, constant: 14),
            icon.centerYAnchor.constraint(equalTo: self.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 44),
            icon.heightAnchor.constraint(equalToConstant: 44),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            label.trailingAnchor.constraint(lessThanOrEqualTo: self.trailingAnchor, constant: -14),
            label.centerYAnchor.constraint(equalTo: self.centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    override func mouseDragged(with event: NSEvent) {
        let bundleURL = Bundle.main.bundleURL
        let item = NSDraggingItem(pasteboardWriter: bundleURL as NSURL)
        item.setDraggingFrame(self.bounds, contents: self.snapshotImage())
        let session = self.beginDraggingSession(with: [item], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation
    {
        .copy
    }

    private func snapshotImage() -> NSImage {
        let bitmap = self.bitmapImageRepForCachingDisplay(in: self.bounds)
            ?? NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: Int(self.bounds.width),
                pixelsHigh: Int(self.bounds.height),
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0)!
        self.cacheDisplay(in: self.bounds, to: bitmap)
        let image = NSImage(size: self.bounds.size)
        image.addRepresentation(bitmap)
        return image
    }
}
