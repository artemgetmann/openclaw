import Foundation
import OpenClawProtocol

extension ChannelsStore {
    func start() {
        guard !self.isPreview else { return }
        guard self.pollTask == nil else { return }
        self.pollTask = Task.detached { [weak self] in
            guard let self else { return }
            await self.refresh(probe: true)
            await self.loadConfigSchema()
            await self.loadConfig()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
                await self.refresh(probe: false)
            }
        }
    }

    func stop() {
        self.pollTask?.cancel()
        self.pollTask = nil
    }

    func refresh(probe: Bool) async {
        guard !self.isRefreshing else { return }
        self.isRefreshing = true
        defer { self.isRefreshing = false }

        do {
            let params: [String: AnyCodable] = [
                "probe": AnyCodable(probe),
                "timeoutMs": AnyCodable(8000),
            ]
            let snap: ChannelsStatusSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .channelsStatus,
                params: params,
                timeoutMs: 12000)
            self.snapshot = snap
            self.reconcileTelegramSetupProgress(with: snap)
            self.lastSuccess = Date()
            self.lastError = nil
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func startWhatsAppLogin(force: Bool, autoWait: Bool = true) async {
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { self.whatsappBusy = false }
        var shouldAutoWait = false
        do {
            let params: [String: AnyCodable] = [
                "force": AnyCodable(force),
                "timeoutMs": AnyCodable(30000),
            ]
            let result: WhatsAppLoginStartResult = try await GatewayConnection.shared.requestDecoded(
                method: .webLoginStart,
                params: params,
                timeoutMs: 35000)
            self.whatsappLoginMessage = result.message
            self.whatsappLoginQrDataUrl = result.qrDataUrl
            self.whatsappLoginConnected = nil
            shouldAutoWait = autoWait && result.qrDataUrl != nil
        } catch {
            self.whatsappLoginMessage = error.localizedDescription
            self.whatsappLoginQrDataUrl = nil
            self.whatsappLoginConnected = nil
        }
        await self.refresh(probe: true)
        if shouldAutoWait {
            Task { await self.waitWhatsAppLogin() }
        }
    }

    func waitWhatsAppLogin(timeoutMs: Int = 120_000) async {
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { self.whatsappBusy = false }
        do {
            let params: [String: AnyCodable] = [
                "timeoutMs": AnyCodable(timeoutMs),
            ]
            let result: WhatsAppLoginWaitResult = try await GatewayConnection.shared.requestDecoded(
                method: .webLoginWait,
                params: params,
                timeoutMs: Double(timeoutMs) + 5000)
            self.whatsappLoginMessage = result.message
            self.whatsappLoginConnected = result.connected
            if result.connected {
                self.whatsappLoginQrDataUrl = nil
            }
        } catch {
            self.whatsappLoginMessage = error.localizedDescription
        }
        await self.refresh(probe: true)
    }

    func logoutWhatsApp() async {
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { self.whatsappBusy = false }
        do {
            let params: [String: AnyCodable] = [
                "channel": AnyCodable("whatsapp"),
            ]
            let result: ChannelLogoutResult = try await GatewayConnection.shared.requestDecoded(
                method: .channelsLogout,
                params: params,
                timeoutMs: 15000)
            self.whatsappLoginMessage = result.cleared
                ? "Logged out and cleared credentials."
                : "No WhatsApp session found."
            self.whatsappLoginQrDataUrl = nil
        } catch {
            self.whatsappLoginMessage = error.localizedDescription
        }
        await self.refresh(probe: true)
    }

    func logoutTelegram() async {
        guard !self.telegramBusy else { return }
        self.telegramBusy = true
        defer { self.telegramBusy = false }
        do {
            let params: [String: AnyCodable] = [
                "channel": AnyCodable("telegram"),
            ]
            let result: ChannelLogoutResult = try await GatewayConnection.shared.requestDecoded(
                method: .channelsLogout,
                params: params,
                timeoutMs: 15000)
            if result.envToken == true {
                self.configStatus = "Telegram token still set via env; config cleared."
            } else {
                self.configStatus = result.cleared
                    ? "Telegram token cleared."
                    : "No Telegram token configured."
            }
            self.clearConsumerTelegramFirstTaskVerified()
            await self.loadConfig()
        } catch {
            self.configStatus = error.localizedDescription
        }
        await self.refresh(probe: true)
    }
}

extension ChannelsStore {
    private func reconcileTelegramSetupProgress(with snap: ChannelsStatusSnapshot) {
        guard AppFlavor.current.isConsumer else { return }
        guard let status = snap.decodeChannel("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
        else { return }

        let probeOK = status.probe?.ok == true
        let botRunning = status.running || probeOK
        guard status.configured, botRunning else { return }

        // Once the consumer Telegram lane is configured and healthy, the setup
        // wizard should stop showing stale "waiting/saving" states. The config on
        // disk is already the source of truth at this point, so the UI should move
        // into a stable "bot is live" state instead of pretending onboarding is
        // still in progress.
        self.telegramSetupWaitingForDM = false
        self.telegramSetupPhase = .idle

        if let username = status.probe?.bot?.username, !username.isEmpty {
            self.telegramSetupBotUsername = username
            UserDefaults.standard.set(
                username,
                forKey: ChannelsStore.consumerTelegramBotUsernameDefaultsKey)
        }

        if self.telegramSetupStatus == nil
            || self.telegramSetupStatus == "Waiting for your first Telegram task..."
            || self.telegramSetupStatus == "Saving Telegram setup..."
            || self.telegramSetupStatus?.hasPrefix("Token verified") == true
        {
            let username = status.probe?.bot?.username ?? self.telegramSetupBotUsername
            if self.consumerTelegramFirstTaskVerified {
                self.telegramSetupStatus = username.map {
                    "Telegram bot is live as @\($0). First task verified."
                } ?? "Telegram bot is live. First task verified."
            } else {
                self.telegramSetupStatus = username.map {
                    "Telegram bot is live as @\($0). Send your first task, then click Verify first task."
                } ?? "Telegram bot is live. Send your first task, then click Verify first task."
            }
        }
    }
}

private struct WhatsAppLoginStartResult: Codable {
    let qrDataUrl: String?
    let message: String
}

private struct WhatsAppLoginWaitResult: Codable {
    let connected: Bool
    let message: String
}

private struct ChannelLogoutResult: Codable {
    let channel: String?
    let accountId: String?
    let cleared: Bool
    let envToken: Bool?
}
