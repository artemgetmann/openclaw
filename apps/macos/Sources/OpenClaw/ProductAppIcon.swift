import AppKit
import SwiftUI

/// One shape contract for Jarvis artwork rendered inside our own views.
///
/// macOS masks an app icon automatically in system-owned surfaces such as the
/// Dock. `NSImageView` and SwiftUI's `Image`, however, render the raw ICNS
/// bitmap. The Jarvis bitmap intentionally fills its square canvas, so every
/// custom product-icon surface must apply the same continuous-corner mask.
enum ProductAppIconStyle {
    static let continuousCornerRadiusRatio: CGFloat = 0.22

    static func cornerRadius(for size: CGFloat) -> CGFloat {
        size * self.continuousCornerRadiusRatio
    }
}

/// Resolves the same packaged artwork everywhere the product icon appears.
///
/// UI-smoke wrappers can expose a generic `NSApp.applicationIconImage`, even
/// though they bundle the real Jarvis asset. Prefer that explicit consumer
/// resource, then fall back to the application icon for standard builds.
@MainActor
enum ProductAppIconArtwork {
    static func image() -> NSImage {
        if AppFlavor.current.isConsumer,
           let url = Bundle.main.url(forResource: "Jarvis", withExtension: "icns"),
           let image = NSImage(contentsOf: url)
        {
            return image
        }
        // `NSApp` is an implicitly-unwrapped global and can still be nil in a
        // SwiftPM test host before AppKit has initialized. `shared` safely
        // creates the application object and preserves the same runtime icon.
        return NSApplication.shared.applicationIconImage ?? CritterIconRenderer.makeIcon(blink: 0)
    }
}

/// SwiftUI product icon with the canonical Jarvis app-icon silhouette.
struct ProductAppIconView: View {
    let size: CGFloat

    var body: some View {
        Image(nsImage: ProductAppIconArtwork.image())
            .resizable()
            .scaledToFill()
            .frame(width: self.size, height: self.size)
            .clipShape(
                RoundedRectangle(
                    cornerRadius: ProductAppIconStyle.cornerRadius(for: self.size),
                    style: .continuous))
    }
}

/// AppKit counterpart used by draggable tiles and any future native subviews.
///
/// Keeping the mask in this shared image view prevents a new AppKit surface
/// from accidentally exposing the square source bitmap again.
@MainActor
final class ProductAppIconImageView: NSImageView {
    init(size: CGFloat) {
        super.init(frame: .zero)
        self.image = ProductAppIconArtwork.image()
        self.imageScaling = .scaleProportionallyUpOrDown
        self.wantsLayer = true
        self.layer?.cornerRadius = ProductAppIconStyle.cornerRadius(for: size)
        self.layer?.cornerCurve = .continuous
        self.layer?.masksToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }
}
