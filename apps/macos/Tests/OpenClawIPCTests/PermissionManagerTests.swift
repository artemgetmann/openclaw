import CoreLocation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct PermissionManagerTests {
    @Test func `voice wake permission helpers match status`() async {
        let direct = PermissionManager.voiceWakePermissionsGranted()
        let ensured = await PermissionManager.ensureVoiceWakePermissions(interactive: false)
        #expect(ensured == direct)
    }

    @Test func `status can query non interactive caps`() async {
        let caps: [Capability] = [.microphone, .speechRecognition, .screenRecording]
        let status = await PermissionManager.status(caps)
        #expect(status.keys.count == caps.count)
    }

    @Test func `ensure non interactive does not throw`() async {
        let caps: [Capability] = [.microphone, .speechRecognition, .screenRecording]
        let ensured = await PermissionManager.ensure(caps, interactive: false)
        #expect(ensured.keys.count == caps.count)
    }

    @Test func `location status matches authorization always`() async {
        let status = CLLocationManager().authorizationStatus
        let results = await PermissionManager.status([.location])
        #expect(results[.location] == (status == .authorizedAlways))
    }

    @Test func `ensure location non interactive matches authorization always`() async {
        let status = CLLocationManager().authorizationStatus
        let ensured = await PermissionManager.ensure([.location], interactive: false)
        #expect(ensured[.location] == (status == .authorizedAlways))
    }

    @Test func `screen recording recovery actions request first and then open settings`() async {
        let actions = PermissionManager.screenRecordingRecoveryActions(
            interactive: true,
            initialGranted: false,
            grantedAfterRequest: false)

        #expect(actions == [.requestAuthorization, .openSettingsFallback])
    }

    @Test func `screen recording recovery actions stop after request when access is granted`() async {
        let actions = PermissionManager.screenRecordingRecoveryActions(
            interactive: true,
            initialGranted: false,
            grantedAfterRequest: true)

        #expect(actions == [.requestAuthorization])
    }
}
