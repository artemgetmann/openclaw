import AppKit
import SwiftUI

let consumerTelegramGroupGuideDismissedKey = "consumerTelegramGroupGuideDismissed"

struct ChannelsSettings: View {
    struct ChannelItem: Identifiable, Hashable {
        let id: String
        let title: String
        let detailTitle: String
        let systemImage: String
        let sortOrder: Int
    }

    @Bindable var store: ChannelsStore
    @State var selectedChannel: ChannelItem?
    @AppStorage(consumerTelegramGroupGuideDismissedKey) var consumerTelegramGroupGuideDismissed = false

    init(store: ChannelsStore = .shared) {
        self.store = store
    }
}
