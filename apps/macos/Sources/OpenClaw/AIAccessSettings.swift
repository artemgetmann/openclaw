import SwiftUI

struct AIAccessSettings: View {
    @State private var modelSetup = ConsumerModelSetupModel()

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                ConsumerModelSetupCardContent(model: self.modelSetup)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
        }
    }
}

#if DEBUG
struct AIAccessSettings_Previews: PreviewProvider {
    static var previews: some View {
        AIAccessSettings()
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
