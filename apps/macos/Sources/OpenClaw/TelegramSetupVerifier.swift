import Foundation

struct TelegramSetupBotInfo: Sendable, Equatable {
    let id: Int
    let username: String?
}

struct TelegramSetupDirectMessage: Sendable, Equatable {
    let updateId: Int
    let messageId: Int
    let chatId: Int64
    let chatUsername: String?
    let senderId: Int
    let senderUsername: String?
    let senderFirstName: String?
    let text: String?
    let caption: String?
    let date: Int
    let messageThreadId: Int?
}

enum TelegramSetupVerifierError: LocalizedError {
    case malformedToken
    case transport(String)
    case api(String)
    case conflict
    case noDirectMessage

    var errorDescription: String? {
        switch self {
        case .malformedToken:
            return "Paste a valid BotFather token first."
        case let .transport(message):
            return "Telegram API request failed: \(message)"
        case let .api(message):
            return message
        case .conflict:
            return "This bot is already active somewhere else. Close the other Jarvis window or use a different bot token."
        case .noDirectMessage:
            return "No Telegram message arrived yet. Send “Wake up, my friend!” to the bot, then click Verify Telegram again."
        }
    }
}

enum TelegramSetupVerifier {
    private static let session: URLSession = {
        // Keep setup token checks bounded. A slow network should show a real error,
        // not leave the setup card in a vague "checking" state forever.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 15
        return URLSession(configuration: configuration)
    }()
    private static let invalidTokenMessage =
        "Telegram did not accept that token. Paste the exact BotFather token for this bot and try again."

    static func normalizeToken(_ raw: String) -> String {
        // BotFather tokens never need quotes, whitespace, control chars, or
        // invisible formatting marks. Stripping those makes rich-client copy/paste
        // resilient without changing valid token punctuation.
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let unquoted = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        let filteredScalars = unquoted.unicodeScalars.filter { scalar in
            if CharacterSet.whitespacesAndNewlines.contains(scalar) {
                return false
            }
            if CharacterSet.controlCharacters.contains(scalar) {
                return false
            }
            if scalar.properties.generalCategory == .format {
                return false
            }
            return true
        }
        return String(String.UnicodeScalarView(filteredScalars))
    }

    static func verifyBot(token: String) async throws -> TelegramSetupBotInfo {
        let response: TelegramBotUser = try await self.request(
            token: token,
            method: "getMe",
            queryItems: [])
        return TelegramSetupBotInfo(id: response.id, username: response.username)
    }

    static func waitForFirstDirectMessage(
        token: String,
        timeoutSeconds: TimeInterval = 45
    ) async throws -> TelegramSetupDirectMessage? {
        try await self.waitForFirstDirectMessage(
            token: token,
            timeoutSeconds: timeoutSeconds,
            fetchUpdates: { token, offset in
                try await self.request(
                    token: token,
                    method: "getUpdates",
                    queryItems: self.updatesQueryItems(offset: offset))
            },
            sleep: { try await Task.sleep(nanoseconds: $0) })
    }

    static func waitForFirstDirectMessage(
        token: String,
        timeoutSeconds: TimeInterval,
        fetchUpdates: @escaping (String, Int?) async throws -> [TelegramUpdate],
        sleep: @escaping (UInt64) async throws -> Void
    ) async throws -> TelegramSetupDirectMessage? {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var offset: Int?
        var latestRetryableError: TelegramSetupVerifierError?

        while Date() < deadline {
            let response: [TelegramUpdate]
            do {
                response = try await fetchUpdates(token, offset)
                latestRetryableError = nil
            } catch let error as TelegramSetupVerifierError {
                // The gateway poller may need a moment to release getUpdates
                // after onboarding disables Telegram. A brief 409 or transport
                // failure is therefore recoverable inside the existing wait;
                // invalid tokens and other API failures are not.
                switch error {
                case .conflict, .transport:
                    latestRetryableError = error
                    try await sleep(1_500_000_000)
                    continue
                case .malformedToken, .api, .noDirectMessage:
                    throw error
                }
            } catch {
                // URLSession can throw URLError before request() converts a
                // response into a Telegram-specific error. Retry those raw
                // transport failures too, but never turn task cancellation
                // into another network attempt.
                if Task.isCancelled || error is CancellationError {
                    throw error
                }
                latestRetryableError = .transport(error.localizedDescription)
                try await sleep(1_500_000_000)
                continue
            }

            if let update = response.compactMap(Self.directMessage).first {
                return update
            }

            if let lastUpdate = response.last {
                offset = lastUpdate.updateId + 1
            }

            try await sleep(1_500_000_000)
        }

        if let latestRetryableError {
            throw latestRetryableError
        }
        return nil
    }

    private static func directMessage(from update: TelegramUpdate) -> TelegramSetupDirectMessage? {
        guard let message = update.message else { return nil }
        guard message.chat.type == "private" else { return nil }
        guard let sender = message.from, sender.isBot != true else { return nil }
        guard self.isFirstTaskMessage(text: message.text, caption: message.caption) else { return nil }
        return TelegramSetupDirectMessage(
            updateId: update.updateId,
            messageId: message.messageId,
            chatId: message.chat.id,
            chatUsername: message.chat.username,
            senderId: sender.id,
            senderUsername: sender.username,
            senderFirstName: sender.firstName,
            text: message.text,
            caption: message.caption,
            date: message.date,
            messageThreadId: message.messageThreadId)
    }

    static func isFirstTaskMessage(text: String?, caption: String?) -> Bool {
        // Telegram's Start button sends /start. It activates the chat but is not
        // the user's first task, so keep polling until an actual text or caption
        // arrives. This also makes Verify safe to click before the user sends the
        // requested wake-up message.
        let normalizedText = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalizedCaption = caption?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalizedText.isEmpty || !normalizedCaption.isEmpty else { return false }

        let command = normalizedText
            .lowercased()
            .split(whereSeparator: \.isWhitespace)
            .first
            .map(String.init)
        return command != "/start" && command?.hasPrefix("/start@") != true
    }

    private static func updatesQueryItems(offset: Int?) -> [URLQueryItem] {
        var items = [
            URLQueryItem(name: "timeout", value: "1"),
            URLQueryItem(name: "limit", value: "50"),
            URLQueryItem(name: "allowed_updates", value: "[\"message\"]"),
        ]
        if let offset {
            items.append(URLQueryItem(name: "offset", value: String(offset)))
        }
        return items
    }

    private static func request<Response: Decodable>(
        token: String,
        method: String,
        queryItems: [URLQueryItem]
    ) async throws -> Response {
        let normalizedToken = self.normalizeToken(token)
        guard !normalizedToken.isEmpty else {
            throw TelegramSetupVerifierError.malformedToken
        }

        let url = try self.requestURL(token: normalizedToken, method: method, queryItems: queryItems)
        let (data, response) = try await self.session.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw TelegramSetupVerifierError.transport("missing HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw self.httpError(statusCode: http.statusCode, data: data)
        }

        do {
            let decoded = try JSONDecoder().decode(TelegramAPIEnvelope<Response>.self, from: data)
            guard decoded.ok else {
                if decoded.errorCode == 409 {
                    throw TelegramSetupVerifierError.conflict
                }
                throw TelegramSetupVerifierError.api(decoded.description ?? "Telegram rejected the request.")
            }
            return decoded.result
        } catch let error as TelegramSetupVerifierError {
            throw error
        } catch {
            throw TelegramSetupVerifierError.transport(error.localizedDescription)
        }
    }

    static func requestURL(token: String, method: String, queryItems: [URLQueryItem]) throws -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.telegram.org"
        // Telegram expects the raw token path segment, including the colon between
        // bot id and secret. Encoding the token turns ":" into "%3A" and makes a
        // valid token look invalid to the API.
        components.path = "/bot\(token)/\(method)"
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else {
            throw TelegramSetupVerifierError.malformedToken
        }
        return url
    }

    private static func httpError(statusCode: Int, data: Data) -> TelegramSetupVerifierError {
        let body = String(data: data, encoding: .utf8) ?? "HTTP \(statusCode)"
        if statusCode == 401 || statusCode == 404 {
            return .api(self.invalidTokenMessage)
        }
        return .transport(body)
    }
}

private struct TelegramAPIEnvelope<Result: Decodable>: Decodable {
    let ok: Bool
    let result: Result
    let description: String?
    let errorCode: Int?

    private enum CodingKeys: String, CodingKey {
        case ok
        case result
        case description
        case errorCode = "error_code"
    }
}

private struct TelegramBotUser: Decodable {
    let id: Int
    let username: String?
}

struct TelegramUpdate: Decodable {
    let updateId: Int
    let message: TelegramMessage?

    private enum CodingKeys: String, CodingKey {
        case updateId = "update_id"
        case message
    }
}

struct TelegramMessage: Decodable {
    let messageId: Int
    let from: TelegramUser?
    let chat: TelegramChat
    let text: String?
    let caption: String?
    let date: Int
    let messageThreadId: Int?

    private enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case from
        case chat
        case text
        case caption
        case date
        case messageThreadId = "message_thread_id"
    }
}

struct TelegramUser: Decodable {
    let id: Int
    let isBot: Bool?
    let firstName: String?
    let username: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case isBot = "is_bot"
        case firstName = "first_name"
        case username
    }
}

struct TelegramChat: Decodable {
    let id: Int64
    let type: String
    let username: String?
}
