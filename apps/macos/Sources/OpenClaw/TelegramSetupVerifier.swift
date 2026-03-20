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
}

enum TelegramSetupVerifierError: LocalizedError {
    case malformedToken
    case transport(String)
    case api(String)
    case noDirectMessage

    var errorDescription: String? {
        switch self {
        case .malformedToken:
            return "Paste a valid BotFather token first."
        case let .transport(message):
            return "Telegram API request failed: \(message)"
        case let .api(message):
            return message
        case .noDirectMessage:
            return "No Telegram DM arrived yet. Ask the user to send the bot a private message, then try again."
        }
    }
}

enum TelegramSetupVerifier {
    private static let session = URLSession(configuration: .ephemeral)

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
            senderFirstName: sender.firstName)
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
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TelegramSetupVerifierError.malformedToken
        }

        let url = try self.url(token: token, method: method, queryItems: queryItems)
        let (data, response) = try await self.session.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw TelegramSetupVerifierError.transport("missing HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw TelegramSetupVerifierError.transport(body)
        }

        do {
            let decoded = try JSONDecoder().decode(TelegramAPIEnvelope<Response>.self, from: data)
            guard decoded.ok else {
                throw TelegramSetupVerifierError.api(decoded.description ?? "Telegram rejected the request.")
            }
            return decoded.result
        } catch let error as TelegramSetupVerifierError {
            throw error
        } catch {
            throw TelegramSetupVerifierError.transport(error.localizedDescription)
        }
    }

    private static func url(token: String, method: String, queryItems: [URLQueryItem]) throws -> URL {
        guard let encodedToken = token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            throw TelegramSetupVerifierError.malformedToken
        }
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.telegram.org"
        components.path = "/bot\(encodedToken)/\(method)"
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else {
            throw TelegramSetupVerifierError.malformedToken
        }
        return url
    }
}

private struct TelegramAPIEnvelope<Result: Decodable>: Decodable {
    let ok: Bool
    let result: Result
    let description: String?
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

    private enum CodingKeys: String, CodingKey {
        case from
        case chat
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
