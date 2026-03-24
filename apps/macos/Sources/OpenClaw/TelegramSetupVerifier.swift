import Foundation

struct TelegramSetupBotInfo: Sendable, Equatable {
    let id: Int
    let username: String?
}

struct TelegramSetupDirectMessage: Sendable, Equatable {
    let updateId: Int
    let senderId: Int
    let senderUsername: String?
    let senderFirstName: String?
    let messageText: String?
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
            return "This bot is already being used by another OpenClaw Telegram poller. Stop the other runtime, or let setup pause Telegram before trying again."
        case .noDirectMessage:
            return "No Telegram DM arrived yet. Ask the user to send the bot a private message, then try again."
        }
    }
}

enum TelegramSetupVerifier {
    private static let session: URLSession = {
        // Telegram token verification should feel instant. Keep request/resource
        // timeouts short so the UI never sits in a fake "checking..." state for a
        // minute just because DNS/TLS/network is unhappy.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 15
        return URLSession(configuration: configuration)
    }()
    private static let invalidTokenMessage =
        "Telegram did not accept that token. Paste the exact BotFather token for this bot and try again."

    static func normalizeToken(_ raw: String) -> String {
        // BotFather tokens never need quotes, whitespace, control chars, or invisible
        // formatting marks. Stripping them makes copy/paste from rich clients resilient.
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
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var offset: Int?

        while Date() < deadline {
            let response: [TelegramUpdate] = try await self.request(
                token: token,
                method: "getUpdates",
                queryItems: self.updatesQueryItems(offset: offset))

            if let update = response.compactMap(Self.directMessage).first {
                return update
            }

            if let lastUpdate = response.last {
                offset = lastUpdate.updateId + 1
            }

            try await Task.sleep(nanoseconds: 1_500_000_000)
        }

        return nil
    }

    private static func directMessage(from update: TelegramUpdate) -> TelegramSetupDirectMessage? {
        guard let message = update.message else { return nil }
        guard message.chat.type == "private" else { return nil }
        guard let sender = message.from, sender.isBot != true else { return nil }
        return TelegramSetupDirectMessage(
            updateId: update.updateId,
            senderId: sender.id,
            senderUsername: sender.username,
            senderFirstName: sender.firstName,
            messageText: message.text)
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
        // Telegram expects the raw bot token path segment, including the colon between
        // bot id and secret. Encoding the full token turns ":" into "%3A" and makes a
        // valid token look invalid to the Telegram API.
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

private struct TelegramUpdate: Decodable {
    let updateId: Int
    let message: TelegramMessage?

    private enum CodingKeys: String, CodingKey {
        case updateId = "update_id"
        case message
    }
}

private struct TelegramMessage: Decodable {
    let from: TelegramUser?
    let chat: TelegramChat
    let text: String?

    private enum CodingKeys: String, CodingKey {
        case from
        case chat
        case text
    }
}

private struct TelegramChat: Decodable {
    let type: String
}

private struct TelegramUser: Decodable {
    let id: Int
    let username: String?
    let firstName: String?
    let isBot: Bool?

    private enum CodingKeys: String, CodingKey {
        case id
        case username
        case firstName = "first_name"
        case isBot = "is_bot"
    }
}
