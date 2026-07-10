import CoreLocation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
    @MainActor
    final class FakeScreenRecordServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
        let bytes: Data
        var lastPath: String?

        init(bytes: Data) {
            self.bytes = bytes
        }

        func recordScreen(
            screenIndex: Int?,
            appName: String?,
            bundleId: String?,
            windowId: UInt32?,
            durationMs: Int?,
            fps: Double?,
            includeAudio: Bool?,
            outPath: String?) async throws -> (path: String, hasAudio: Bool, durationMs: Int, fps: Double)
        {
            #expect(appName == "Telegram")
            #expect(bundleId == "ru.keepcoder.Telegram")
            #expect(windowId == 42)
            let url = FileManager().temporaryDirectory
                .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
            try self.bytes.write(to: url)
            self.lastPath = url.path
            // The fake mirrors native clamping so the protocol test proves the
            // response reports effective, not originally requested, metadata.
            return (path: url.path, hasAudio: false, durationMs: 60_000, fps: 60)
        }

        func locationAuthorizationStatus() -> CLAuthorizationStatus {
            .authorizedAlways
        }

        func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
            .fullAccuracy
        }

        func currentLocation(
            desiredAccuracy: OpenClawLocationAccuracy,
            maxAgeMs: Int?,
            timeoutMs: Int?) async throws -> CLLocation
        {
            CLLocation(latitude: 0, longitude: 0)
        }
    }

    @Test func `handle invoke rejects unknown command`() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty system run`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(command: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty system which`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemWhichParams(bins: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2b", command: OpenClawSystemCommand.which.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke rejects empty notification`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemNotifyParams(title: "", body: "")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: OpenClawSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke camera list requires enabled camera`() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(id: "req-4", command: OpenClawCameraCommand.list.rawValue))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func `screen record streams bounded opaque chunks and cleans up`() async throws {
        let expectedBytes = Data(repeating: 0xA5, count: 2 * 1024 * 1024 + 17)
        let services = await MainActor.run { FakeScreenRecordServices(bytes: expectedBytes) }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenRecordParams(
            operation: .capture,
            appName: "Telegram",
            bundleId: "ru.keepcoder.Telegram",
            windowId: 42,
            durationMs: 240_000,
            fps: 120)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-5", command: MacNodeScreenCommand.record.rawValue, paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var artifactId: String
            var byteLength: Int
            var chunkSize: Int
            var durationMs: Int
            var fps: Double
        }
        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "mp4")
        #expect(payload.byteLength == expectedBytes.count)
        #expect(payload.chunkSize == 1024 * 1024)
        #expect(payload.durationMs == 60_000)
        #expect(payload.fps == 60)
        #expect(!payloadJSON.contains("base64"))
        #expect(!payloadJSON.contains("path"))
        #expect(payload.artifactId.range(of: #"^[A-F0-9-]{36}$"#, options: .regularExpression) != nil)

        var assembled = Data()
        var offset = 0
        var chunkCount = 0
        while offset < payload.byteLength {
            let readParams = MacNodeScreenRecordParams(
                operation: .read,
                artifactId: payload.artifactId,
                offset: offset,
                length: payload.chunkSize)
            let readJSON = try String(data: JSONEncoder().encode(readParams), encoding: .utf8)
            let readResponse = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "read-\(chunkCount)",
                command: MacNodeScreenCommand.record.rawValue,
                paramsJSON: readJSON))
            #expect(readResponse.ok == true)
            let readPayloadJSON = try #require(readResponse.payloadJSON)
            // A single response stays bounded even when the retained artifact is
            // much larger than the gateway's frame ceiling.
            #expect(readPayloadJSON.utf8.count < 1_500_000)
            struct Chunk: Decodable {
                var offset: Int
                var byteLength: Int
                var base64: String
                var eof: Bool
            }
            let chunk = try JSONDecoder().decode(Chunk.self, from: Data(readPayloadJSON.utf8))
            #expect(chunk.offset == offset)
            let bytes = try #require(Data(base64Encoded: chunk.base64))
            #expect(bytes.count == chunk.byteLength)
            assembled.append(bytes)
            offset += bytes.count
            chunkCount += 1
            #expect(chunk.eof == (offset == payload.byteLength))
        }
        #expect(chunkCount == 3)
        #expect(assembled == expectedBytes)

        let artifactPath = await MainActor.run { services.lastPath }
        #expect(artifactPath.map(FileManager().fileExists(atPath:)) == true)
        let cleanupParams = MacNodeScreenRecordParams(
            operation: .cleanup,
            artifactId: payload.artifactId)
        let cleanupJSON = try String(data: JSONEncoder().encode(cleanupParams), encoding: .utf8)
        let cleanupResponse = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "cleanup",
            command: MacNodeScreenCommand.record.rawValue,
            paramsJSON: cleanupJSON))
        #expect(cleanupResponse.ok == true)
        #expect(artifactPath.map(FileManager().fileExists(atPath:)) == false)
    }

    @Test func `screen record keeps legacy inline response when operation is absent`() async throws {
        let expectedBytes = Data("legacy".utf8)
        let services = await MainActor.run { FakeScreenRecordServices(bytes: expectedBytes) }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })
        let params = MacNodeScreenRecordParams(
            appName: "Telegram",
            bundleId: "ru.keepcoder.Telegram",
            windowId: 42,
            durationMs: 240_000,
            fps: 120)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "legacy-capture",
            command: MacNodeScreenCommand.record.rawValue,
            paramsJSON: json))
        #expect(response.ok == true)
        struct LegacyPayload: Decodable {
            var base64: String
            var durationMs: Int
            var fps: Double
        }
        let payload = try JSONDecoder().decode(
            LegacyPayload.self,
            from: Data(try #require(response.payloadJSON).utf8))
        #expect(Data(base64Encoded: payload.base64) == expectedBytes)
        #expect(payload.durationMs == 60_000)
        #expect(payload.fps == 60)
        let artifactPath = await MainActor.run { services.lastPath }
        #expect(artifactPath.map(FileManager().fileExists(atPath:)) == false)
    }

    @Test func `screen record rejects invalid chunk ranges`() async throws {
        let services = await MainActor.run { FakeScreenRecordServices(bytes: Data("payload".utf8)) }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })
        let capture = MacNodeScreenRecordParams(
            operation: .capture,
            appName: "Telegram",
            bundleId: "ru.keepcoder.Telegram",
            windowId: 42)
        let captureJSON = try String(data: JSONEncoder().encode(capture), encoding: .utf8)
        let captureResponse = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "capture-invalid-range",
            command: MacNodeScreenCommand.record.rawValue,
            paramsJSON: captureJSON))
        struct Metadata: Decodable { var artifactId: String }
        let metadata = try JSONDecoder().decode(
            Metadata.self,
            from: Data(try #require(captureResponse.payloadJSON).utf8))

        for (offset, length) in [(-1, 1), (0, 1024 * 1024 + 1)] {
            let read = MacNodeScreenRecordParams(
                operation: .read,
                artifactId: metadata.artifactId,
                offset: offset,
                length: length)
            let readJSON = try String(data: JSONEncoder().encode(read), encoding: .utf8)
            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "invalid-range",
                command: MacNodeScreenCommand.record.rawValue,
                paramsJSON: readJSON))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("SCREEN_RECORD_TRANSFER_INVALID") == true)
        }

        let cleanup = MacNodeScreenRecordParams(operation: .cleanup, artifactId: metadata.artifactId)
        let cleanupJSON = try String(data: JSONEncoder().encode(cleanup), encoding: .utf8)
        _ = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "cleanup-invalid-range",
            command: MacNodeScreenCommand.record.rawValue,
            paramsJSON: cleanupJSON))
    }

    @Test func `screen record prunes abandoned artifacts after ttl`() async throws {
        let services = await MainActor.run { FakeScreenRecordServices(bytes: Data("payload".utf8)) }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { services },
            screenRecordArtifactTTL: 0.02)
        let capture = MacNodeScreenRecordParams(
            operation: .capture,
            appName: "Telegram",
            bundleId: "ru.keepcoder.Telegram",
            windowId: 42)
        let captureJSON = try String(data: JSONEncoder().encode(capture), encoding: .utf8)
        let captureResponse = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "capture-expiring",
            command: MacNodeScreenCommand.record.rawValue,
            paramsJSON: captureJSON))
        struct Metadata: Decodable { var artifactId: String }
        let metadata = try JSONDecoder().decode(
            Metadata.self,
            from: Data(try #require(captureResponse.payloadJSON).utf8))
        let artifactPath = await MainActor.run { services.lastPath }
        #expect(artifactPath.map(FileManager().fileExists(atPath:)) == true)

        // Expiry is timer-owned: no later screen.record invocation is needed to
        // trigger eventual deletion of an abandoned node artifact.
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(artifactPath.map(FileManager().fileExists(atPath:)) == false)

        let read = MacNodeScreenRecordParams(
            operation: .read,
            artifactId: metadata.artifactId,
            offset: 0,
            length: 1)
        let readJSON = try String(data: JSONEncoder().encode(read), encoding: .utf8)
        let readResponse = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "read-expired",
            command: MacNodeScreenCommand.record.rawValue,
            paramsJSON: readJSON))
        #expect(readResponse.ok == false)
        #expect(readResponse.error?.message.contains("unknown or expired artifact") == true)
        #expect(artifactPath.map(FileManager().fileExists(atPath:)) == false)
    }

    @Test func `handle invoke browser proxy uses injected request`() async {
        let runtime = MacNodeRuntime(browserProxyRequest: { paramsJSON in
            #expect(paramsJSON?.contains("/tabs") == true)
            return #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#
        })
        let paramsJSON = #"{"method":"GET","path":"/tabs","timeoutMs":2500}"#
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-browser",
                command: OpenClawBrowserCommand.proxy.rawValue,
                paramsJSON: paramsJSON))

        #expect(response.ok == true)
        #expect(response.payloadJSON == #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#)
    }

    @Test func `handle invoke browser proxy rejects disabled browser control`() async throws {
        let override = TestIsolation.tempConfigPath()
        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            try JSONSerialization.data(withJSONObject: ["browser": ["enabled": false]])
                .write(to: URL(fileURLWithPath: override))

            let runtime = MacNodeRuntime(browserProxyRequest: { _ in
                Issue.record("browserProxyRequest should not run when browser control is disabled")
                return "{}"
            })
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-browser-disabled",
                    command: OpenClawBrowserCommand.proxy.rawValue,
                    paramsJSON: #"{"method":"GET","path":"/tabs"}"#))

            #expect(response.ok == false)
            #expect(response.error?.message.contains("BROWSER_DISABLED") == true)
        }
    }
}
