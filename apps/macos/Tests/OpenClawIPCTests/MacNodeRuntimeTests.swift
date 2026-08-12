import CoreLocation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
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

    @Test func `handle invoke screen record uses injected services`() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func checkForAppUpdate() -> OpenClawAppUpdateStatus {
                OpenClawAppUpdateStatus(available: false, readyToInstall: false)
            }

            func appUpdateStatus() -> OpenClawAppUpdateStatus {
                OpenClawAppUpdateStatus(available: false, readyToInstall: false)
            }

            func installAppUpdate(expectedVersion _: String, expectedBuild _: String) throws {}

            func recordScreen(
                screenIndex: Int?,
                appName: String?,
                bundleId: String?,
                windowId: UInt32?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                #expect(appName == "Telegram")
                #expect(bundleId == "ru.keepcoder.Telegram")
                #expect(windowId == 42)
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
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

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenRecordParams(
            appName: "Telegram",
            bundleId: "ru.keepcoder.Telegram",
            windowId: 42,
            durationMs: 250)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-5", command: MacNodeScreenCommand.record.rawValue, paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var base64: String
        }
        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "mp4")
        #expect(!payload.base64.isEmpty)
    }

    @Test func `app update commands pin installation to the approved release`() async throws {
        @MainActor
        final class FakeUpdateServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            var checkedForUpdate = false
            var installedVersion: String?
            var installedBuild: String?

            func checkForAppUpdate() -> OpenClawAppUpdateStatus {
                self.checkedForUpdate = true
                return self.appUpdateStatus()
            }

            func appUpdateStatus() -> OpenClawAppUpdateStatus {
                OpenClawAppUpdateStatus(
                    available: true,
                    readyToInstall: true,
                    gatewayRestartRequired: true,
                    version: "2026.7.29",
                    build: "2026072901")
            }

            func installAppUpdate(expectedVersion: String, expectedBuild: String) throws {
                self.installedVersion = expectedVersion
                self.installedBuild = expectedBuild
            }

            func recordScreen(
                screenIndex _: Int?,
                appName _: String?,
                bundleId _: String?,
                windowId _: UInt32?,
                durationMs _: Int?,
                fps _: Double?,
                includeAudio _: Bool?,
                outPath _: String?) async throws -> (path: String, hasAudio: Bool)
            {
                throw CocoaError(.featureUnsupported)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus {
                .denied
            }

            func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
                .reducedAccuracy
            }

            func currentLocation(
                desiredAccuracy _: OpenClawLocationAccuracy,
                maxAgeMs _: Int?,
                timeoutMs _: Int?) async throws -> CLLocation
            {
                throw CocoaError(.featureUnsupported)
            }
        }

        let services = await MainActor.run { FakeUpdateServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })
        let checkResponse = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "app-update-check",
                command: OpenClawSystemCommand.appUpdateCheck.rawValue))
        #expect(checkResponse.ok)
        let checkJSON = try #require(checkResponse.payloadJSON)
        let checkStatus = try JSONDecoder().decode(
            OpenClawAppUpdateStatus.self,
            from: Data(checkJSON.utf8))
        #expect(checkStatus.version == "2026.7.29")
        await MainActor.run {
            #expect(services.checkedForUpdate)
        }

        let statusResponse = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "app-update-status",
                command: OpenClawSystemCommand.appUpdateStatus.rawValue))
        #expect(statusResponse.ok)
        let statusJSON = try #require(statusResponse.payloadJSON)
        let status = try JSONDecoder().decode(
            OpenClawAppUpdateStatus.self,
            from: Data(statusJSON.utf8))
        #expect(status.version == "2026.7.29")
        #expect(status.build == "2026072901")
        #expect(status.readyToInstall)
        #expect(status.gatewayRestartRequired)

        let params = OpenClawAppUpdateInstallParams(
            expectedVersion: "2026.7.29",
            expectedBuild: "2026072901")
        let paramsJSON = try String(decoding: JSONEncoder().encode(params), as: UTF8.self)
        let installResponse = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "app-update-install",
                command: OpenClawSystemCommand.appUpdateInstall.rawValue,
                paramsJSON: paramsJSON))
        #expect(installResponse.ok)
        await MainActor.run {
            #expect(services.installedVersion == "2026.7.29")
            #expect(services.installedBuild == "2026072901")
        }
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
