import Foundation

extension OnboardingView {
    func maybeKickoffOnboardingChat(for pageIndex: Int) {
        guard pageIndex == self.onboardingChatPageIndex else { return }
        guard self.showOnboardingChat else { return }
        guard !self.didAutoKickoff else { return }
        self.didAutoKickoff = true

        Task { @MainActor in
            for _ in 0..<20 {
                if !self.onboardingChatModel.isLoading { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            guard self.onboardingChatModel.messages.isEmpty else { return }
            let kickoff =
                "Hi! I just installed OpenClaw and you’re my brand-new agent. " +
                "Start with BOOTSTRAP.md and ask one question at a time so we can figure out your name, " +
                "what to call me, and how you should talk. Use IDENTITY.md, USER.md, and SOUL.md as needed, " +
                "but keep the conversation simple and non-technical. Then walk me through Telegram setup, " +
                "start with DMs, and mention groups or topics only if they’ll actually help."
            self.onboardingChatModel.input = kickoff
            self.onboardingChatModel.send()
        }
    }
}
