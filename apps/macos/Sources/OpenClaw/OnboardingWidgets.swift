import AppKit
import SwiftUI

struct GlowingOpenClawIcon: View {
    @Environment(\.scenePhase) private var scenePhase

    let size: CGFloat
    let glowIntensity: Double
    let enableFloating: Bool

    @State private var breathe = false

    init(size: CGFloat = 148, glowIntensity: Double = 0.35, enableFloating: Bool = true) {
        self.size = size
        self.glowIntensity = glowIntensity
        self.enableFloating = enableFloating
    }

    var body: some View {
        let glowBlurRadius: CGFloat = 18
        let glowCanvasSize: CGFloat = self.size + 56
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor.opacity(self.glowIntensity),
                            Color.blue.opacity(self.glowIntensity * 0.6),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .frame(width: glowCanvasSize, height: glowCanvasSize)
                .padding(glowBlurRadius)
                .blur(radius: glowBlurRadius)
                .scaleEffect(self.breathe ? 1.08 : 0.96)
                .opacity(0.84)

            Image(nsImage: Self.onboardingIconImage())
                .resizable()
                .frame(width: self.size, height: self.size)
                .clipShape(RoundedRectangle(cornerRadius: self.size * 0.22, style: .continuous))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                .scaleEffect(self.breathe ? 1.02 : 1.0)
        }
        .frame(
            width: glowCanvasSize + (glowBlurRadius * 2),
            height: glowCanvasSize + (glowBlurRadius * 2))
        .onAppear { self.updateBreatheAnimation() }
        .onDisappear { self.breathe = false }
        .onChange(of: self.scenePhase) { _, _ in
            self.updateBreatheAnimation()
        }
    }

    private func updateBreatheAnimation() {
        guard self.enableFloating, self.scenePhase == .active else {
            self.breathe = false
            return
        }
        guard !self.breathe else { return }
        withAnimation(Animation.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
            self.breathe = true
        }
    }

    private static func onboardingIconImage() -> NSImage {
        // UI-smoke launches through a tiny debug wrapper, so NSApp can expose
        // the generic macOS placeholder instead of the product icon. Prefer the
        // bundled Jarvis asset for first-run setup where brand recognition matters.
        if AppFlavor.current.isConsumer,
           let url = OnboardingIconResourceLocator.consumerIconURL(),
           let image = NSImage(contentsOf: url)
        {
            return image
        }
        return NSApp.applicationIconImage
    }
}

enum OnboardingIconResourceLocator {
    private static let consumerIconName = "Jarvis"
    private static let packagedOpenClawResourceBundleName = "OpenClaw_OpenClaw"

    static func consumerIconURL(
        mainBundle: Bundle = .main,
        moduleBundle: () -> Bundle = { Bundle.module }
    ) -> URL? {
        // Packaged apps receive SwiftPM resources as a copied bundle under
        // Contents/Resources. Check those paths before touching Bundle.module:
        // SwiftPM's generated accessor traps if its expected bundle is absent.
        if let url = mainBundle.url(forResource: self.consumerIconName, withExtension: "icns") {
            return url
        }

        if let bundle = self.packagedOpenClawResourceBundle(in: mainBundle),
           let url = bundle.url(forResource: self.consumerIconName, withExtension: "icns")
        {
            return url
        }

        // A bad package should degrade to NSApp.applicationIconImage, not crash
        // first-run onboarding while drawing the first screen.
        guard !self.isPackagedApp(mainBundle) else { return nil }

        return moduleBundle().url(forResource: self.consumerIconName, withExtension: "icns")
    }

    private static func packagedOpenClawResourceBundle(in mainBundle: Bundle) -> Bundle? {
        if let bundleURL = mainBundle.url(
            forResource: self.packagedOpenClawResourceBundleName,
            withExtension: "bundle"),
            let bundle = Bundle(url: bundleURL)
        {
            return bundle
        }

        // Some test and packaging launch paths expose resourceURL even when
        // Bundle.url(forResource:) does not index nested resource bundles yet.
        guard let resourceURL = mainBundle.resourceURL else { return nil }
        let bundleURL = resourceURL
            .appendingPathComponent(self.packagedOpenClawResourceBundleName)
            .appendingPathExtension("bundle")
        return Bundle(url: bundleURL)
    }

    private static func isPackagedApp(_ bundle: Bundle) -> Bool {
        bundle.bundleURL.pathExtension.caseInsensitiveCompare("app") == .orderedSame
    }
}
