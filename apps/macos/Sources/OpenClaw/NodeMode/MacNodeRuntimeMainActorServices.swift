import CoreLocation
import Foundation
import OpenClawKit

@MainActor
protocol MacNodeRuntimeMainActorServices: Sendable {
    func checkForAppUpdate() async -> OpenClawAppUpdateStatus
    func appUpdateStatus() -> OpenClawAppUpdateStatus
    func installAppUpdate(expectedVersion: String, expectedBuild: String) throws

    func recordScreen(
        screenIndex: Int?,
        appName: String?,
        bundleId: String?,
        windowId: UInt32?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)
    func ensureScreenRecordingPermission() async -> Bool

    func locationAuthorizationStatus() -> CLAuthorizationStatus
    func requestLocationAuthorization() async -> CLAuthorizationStatus
    func locationAccuracyAuthorization() -> CLAccuracyAuthorization
    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
}

@MainActor
final class LiveMacNodeRuntimeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
    private let screenRecorder = ScreenRecordService()
    private let locationService = MacNodeLocationService()

    func checkForAppUpdate() async -> OpenClawAppUpdateStatus {
        await AppUpdateControllerRegistry.shared.checkForUpdatesInBackground()
    }

    func appUpdateStatus() -> OpenClawAppUpdateStatus {
        AppUpdateControllerRegistry.shared.status()
    }

    func installAppUpdate(expectedVersion: String, expectedBuild: String) throws {
        try AppUpdateControllerRegistry.shared.install(
            expectedVersion: expectedVersion,
            expectedBuild: expectedBuild)
    }

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
        try await self.screenRecorder.record(
            screenIndex: screenIndex,
            appName: appName,
            bundleId: bundleId,
            windowId: windowId,
            durationMs: durationMs,
            fps: fps,
            includeAudio: includeAudio,
            outPath: outPath)
    }

    func ensureScreenRecordingPermission() async -> Bool {
        await PermissionManager.ensure([.screenRecording], interactive: true)[.screenRecording] ?? false
    }

    func locationAuthorizationStatus() -> CLAuthorizationStatus {
        self.locationService.authorizationStatus()
    }

    func requestLocationAuthorization() async -> CLAuthorizationStatus {
        await LocationPermissionRequester.shared.request(always: false)
    }

    func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
        self.locationService.accuracyAuthorization()
    }

    func currentLocation(
        desiredAccuracy: OpenClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        try await self.locationService.currentLocation(
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs)
    }
}
