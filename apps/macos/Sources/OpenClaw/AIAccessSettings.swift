import SwiftUI

struct AIAccessSettings: View {
    @State private var modelSetup = ConsumerModelSetupModel()

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("AI access")
                        .font(.title3.weight(.semibold))
                    Text("OpenAI is the default self-serve path here. Claude login, setup-token, and API-key access stay available when this runtime supports them.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

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
