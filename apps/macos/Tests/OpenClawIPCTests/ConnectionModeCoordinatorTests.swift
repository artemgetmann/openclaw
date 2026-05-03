import OpenClawKit
import Testing
@testable import OpenClaw

struct ConnectionModeCoordinatorTests {
    @Test func `consumer unconfigured mode preserves gateway`() {
        #expect(!ConnectionModeCoordinator.shouldStopGatewayForUnconfiguredMode(appFlavor: .consumer))
    }

    @Test func `standard unconfigured mode can stop gateway`() {
        #expect(ConnectionModeCoordinator.shouldStopGatewayForUnconfiguredMode(appFlavor: .standard))
    }
}
