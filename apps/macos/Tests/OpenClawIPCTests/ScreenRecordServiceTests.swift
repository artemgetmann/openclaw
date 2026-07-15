import CoreGraphics
import Testing
@testable import OpenClaw

struct ScreenRecordServiceTests {
    @Test
    @MainActor
    func `realistic app window filter rejects helpers and thumbnails`() {
        #expect(!ScreenRecordService.isRealisticAppWindowFrame(CGRect(x: 0, y: 0, width: 140, height: 168)))
        #expect(!ScreenRecordService.isRealisticAppWindowFrame(CGRect(x: 0, y: 0, width: 319, height: 1000)))
        #expect(!ScreenRecordService.isRealisticAppWindowFrame(CGRect(x: 0, y: 0, width: 400, height: 240)))
        #expect(ScreenRecordService.isRealisticAppWindowFrame(CGRect(x: 0, y: 0, width: 417, height: 240)))
        #expect(ScreenRecordService.isRealisticAppWindowFrame(CGRect(x: 0, y: 0, width: 1280, height: 800)))
    }
}
