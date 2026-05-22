import AppKit
import SwiftUI

extension OnboardingView {
    var body: some View {
        VStack(spacing: 0) {
            GlowingOpenClawIcon(size: 96, glowIntensity: 0.22)
                .offset(y: 8)
                .frame(height: 124)

            GeometryReader { _ in
                HStack(spacing: 0) {
                    ForEach(self.pageOrder, id: \.self) { pageIndex in
                        self.pageView(for: pageIndex)
                            .frame(width: self.pageWidth)
                    }
                }
                .offset(x: CGFloat(-self.currentPage) * self.pageWidth)
                .animation(
                    .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                    value: self.currentPage)
                .frame(height: self.contentHeight, alignment: .top)
                .clipped()
            }
            .frame(height: self.contentHeight)

            Spacer(minLength: 0)
            self.navigationBar
        }
        .frame(width: self.pageWidth, height: Self.windowHeight)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear {
            self.currentPage = 0
            self.updateMonitoring(for: 0)
        }
        .onChange(of: self.currentPage) { _, newValue in
            self.updateMonitoring(for: self.activePageIndex(for: newValue))
        }
        .onChange(of: self.consumerSetupStep) { _, _ in
            self.updateMonitoring(for: self.activePageIndex)
        }
        .onChange(of: self.state.connectionMode) { _, _ in
            let oldActive = self.activePageIndex
            self.reconcilePageForModeChange(previousActivePageIndex: oldActive)
            self.updateDiscoveryMonitoring(for: self.activePageIndex)
        }
        .onChange(of: self.needsBootstrap) { _, _ in
            if self.currentPage >= self.pageOrder.count {
                self.currentPage = max(0, self.pageOrder.count - 1)
            }
        }
        .onChange(of: self.onboardingWizard.isComplete) { _, newValue in
            guard newValue, self.activePageIndex == self.wizardPageIndex else { return }
            self.handleNext()
        }
        .onChange(of: self.accountActivation.isActivated) { _, newValue in
            guard newValue else { return }
            self.advancePastAccountActivationIfReady()
        }
        .onDisappear {
            self.stopPermissionMonitoring()
            self.stopDiscovery()
            Task { await self.onboardingWizard.cancelIfRunning() }
        }
        .task {
            await self.refreshPerms()
            self.refreshCLIStatus()
            await self.loadWorkspaceDefaults()
            await self.ensureDefaultWorkspace()
            self.refreshBootstrapStatus()
            self.preferredGatewayID = GatewayDiscoveryPreferences.preferredStableID()
            if AppFlavor.current.isConsumer, self.state.connectionMode == .unconfigured {
                // Keep the default consumer path local-first even before the
                // user presses the first button so the reduced page order stays stable.
                self.selectLocalGateway()
            }
            await self.accountActivation.loadStoredActivation()
            self.applyConsumerSetupDebugStepOverrideIfNeeded()
            self.advancePastAccountActivationIfReady()
            if !(await self.attemptConsumerSetupResume()) {
                await self.loadConsumerTelegramSetupStateIfNeeded()
            }
        }
    }

    func activePageIndex(for pageCursor: Int) -> Int {
        guard !self.pageOrder.isEmpty else { return 0 }
        let clamped = min(max(0, pageCursor), self.pageOrder.count - 1)
        return self.pageOrder[clamped]
    }

    func applyConsumerSetupDebugStepOverrideIfNeeded(
        environment: [String: String] = ProcessInfo.processInfo.environment)
    {
        guard let step = Self.consumerSetupDebugStep(environment: environment) else { return }
        self.consumerSetupStep = step
    }

    static func consumerSetupDebugStep(environment: [String: String]) -> ConsumerSetupStep? {
        let raw = environment["OPENCLAW_CONSUMER_SETUP_DEBUG_STEP"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let raw, !raw.isEmpty else { return nil }
        return ConsumerSetupStep.allCases.first(where: {
            $0.title.replacingOccurrences(of: " ", with: "").lowercased() == raw ||
                String(describing: $0).lowercased() == raw
        })
    }

    func reconcilePageForModeChange(previousActivePageIndex: Int) {
        if let exact = self.pageOrder.firstIndex(of: previousActivePageIndex) {
            withAnimation { self.currentPage = exact }
            return
        }
        if let next = self.pageOrder.firstIndex(where: { $0 > previousActivePageIndex }) {
            withAnimation { self.currentPage = next }
            return
        }
        withAnimation { self.currentPage = max(0, self.pageOrder.count - 1) }
    }

    var navigationBar: some View {
        if self.isConsumerSetupShellActive {
            return AnyView(self.consumerSetupNavigationBar)
        }
        return AnyView(HStack(spacing: 20) {
            ZStack(alignment: .leading) {
                Button(action: {}, label: {
                    Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
                })
                .buttonStyle(.plain)
                .opacity(0)
                .disabled(true)

                if self.currentPage > 0 {
                    Button(action: self.handleBack, label: {
                        Label("Back", systemImage: "chevron.left")
                            .labelStyle(.iconOnly)
                    })
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
                    .opacity(0.8)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .frame(minWidth: 80, alignment: .leading)

            Spacer()

            Button(action: self.handleNext) {
                Text(self.buttonTitle)
                    .frame(minWidth: 88)
            }
            .keyboardShortcut(.return)
            .buttonStyle(.borderedProminent)
            .disabled(!self.canAdvance)
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 13)
        .frame(minHeight: 60, alignment: .bottom))
    }

    private var consumerSetupNavigationBar: some View {
        HStack(spacing: 16) {
            Button(action: self.handleBack) {
                Label("Back", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .foregroundColor(.secondary)
            .opacity(self.consumerSetupStep.previous == nil ? 0 : 0.8)
            .disabled(self.consumerSetupStep.previous == nil)
            .frame(minWidth: 80, alignment: .leading)

            Spacer()

            Button(action: self.handleNext) {
                Text(self.buttonTitle)
                    .frame(minWidth: 88)
            }
            .keyboardShortcut(.return)
            .buttonStyle(.borderedProminent)
            .disabled(!self.canAdvance)
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 13)
        .frame(minHeight: 60, alignment: .bottom)
    }

    func onboardingPage(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(spacing: 16) {
            content()
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, height: self.contentHeight, alignment: .top)
    }

    func onboardingCard(
        spacing: CGFloat = 12,
        padding: CGFloat = 16,
        @ViewBuilder _ content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: spacing) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3))
    }

    func onboardingGlassCard(
        spacing: CGFloat = 12,
        padding: CGFloat = 16,
        @ViewBuilder _ content: () -> some View) -> some View
    {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return VStack(alignment: .leading, spacing: spacing) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.clear)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }

    func onboardingScrollableCard(
        maxHeight: CGFloat,
        spacing: CGFloat = 12,
        padding: CGFloat = 16,
        @ViewBuilder _ content: () -> some View) -> some View
    {
        ScrollView {
            VStack(alignment: .leading, spacing: spacing) {
                content()
            }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.automatic)
        .frame(maxHeight: maxHeight)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3))
    }

    func featureRow(title: String, subtitle: String, systemImage: String) -> some View {
        self.featureRowContent(title: title, subtitle: subtitle, systemImage: systemImage)
    }

    func featureActionRow(
        title: String,
        subtitle: String,
        systemImage: String,
        buttonTitle: String,
        action: @escaping () -> Void) -> some View
    {
        self.featureRowContent(
            title: title,
            subtitle: subtitle,
            systemImage: systemImage,
            action: AnyView(
                Button(buttonTitle, action: action)
                    .buttonStyle(.link)
                    .padding(.top, 2)))
    }

    private func featureRowContent(
        title: String,
        subtitle: String,
        systemImage: String,
        action: AnyView? = nil) -> some View
    {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let action {
                    action
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}
