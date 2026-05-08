import SwiftUI

struct BrowserSettings: View {
    @State private var browserSetup = BrowserSetupModel()

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Browser")
                        .font(.title3.weight(.semibold))
                    Text("OpenClaw uses your live Chrome session for logged-in sites and keeps its own browser lane available for clean public-site tasks.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                BrowserSetupCardContent(model: self.browserSetup, presentation: .settings)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
        }
        .task {
            await self.browserSetup.refreshIfNeeded()
        }
    }
}

#if DEBUG
struct BrowserSettings_Previews: PreviewProvider {
    static var previews: some View {
        BrowserSettings()
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
