import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw
@testable import OpenClawIPC

private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State = .running

    func resume() {}

    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        self.state = .canceling
    }

    func send(_: URLSessionWebSocketTask.Message) async throws {}

    func receive() async throws -> URLSessionWebSocketTask.Message {
        throw URLError(.cannotConnectToHost)
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        completionHandler(.failure(URLError(.cannotConnectToHost)))
    }
}

private final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    func makeWebSocketTask(url _: URL) -> WebSocketTaskBox {
        WebSocketTaskBox(task: FakeWebSocketTask())
    }
}

private func makeTestGatewayConnection() -> GatewayConnection {
    GatewayConnection(
        configProvider: {
            (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
        },
        sessionBox: WebSocketSessionBox(session: FakeWebSocketSession()))
}

@Suite(.serialized) struct GatewayConnectionControlTests {
    @Test func `local gateway auto recovery ignores timeout and abort noise`() {
        #expect(!GatewayConnection._testShouldAutoRecoverLocalGateway(from: URLError(.timedOut)))

        let aborted = NSError(
            domain: NSCocoaErrorDomain,
            code: NSUserCancelledError,
            userInfo: [NSLocalizedDescriptionKey: "AbortError: This operation was aborted"])
        #expect(!GatewayConnection._testShouldAutoRecoverLocalGateway(from: aborted))
    }

    @Test func `local gateway auto recovery still handles real connection loss`() {
        #expect(GatewayConnection._testShouldAutoRecoverLocalGateway(from: URLError(.cannotConnectToHost)))
        #expect(GatewayConnection._testShouldAutoRecoverLocalGateway(from: URLError(.networkConnectionLost)))

        let closed = NSError(
            domain: "Gateway",
            code: 1006,
            userInfo: [NSLocalizedDescriptionKey: "gateway closed (1006 abnormal closure): no close reason"])
        #expect(GatewayConnection._testShouldAutoRecoverLocalGateway(from: closed))
    }

    @Test func `health probes do not self-recover into launchd churn`() {
        #expect(
            !GatewayConnection._testShouldAutoRecoverLocalGateway(
                method: "health",
                from: URLError(.cannotConnectToHost)))
        #expect(
            GatewayConnection._testShouldAutoRecoverLocalGateway(
                method: "config.get",
                from: URLError(.cannotConnectToHost)))
    }

    @Test func `status fails when process missing`() async {
        let connection = makeTestGatewayConnection()
        let result = await connection.status()
        #expect(result.ok == false)
        #expect(result.error != nil)
    }

    @Test func `reject empty message`() async {
        let connection = makeTestGatewayConnection()
        let result = await connection.sendAgent(
            message: "",
            thinking: nil,
            sessionKey: "main",
            deliver: false,
            to: nil)
        #expect(result.ok == false)
    }
}
