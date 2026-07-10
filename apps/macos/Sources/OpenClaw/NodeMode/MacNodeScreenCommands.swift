import Foundation

enum MacNodeScreenCommand: String, Codable {
    case record = "screen.record"
}

enum MacNodeScreenRecordOperation: String, Codable {
    case capture
    case read
    case cleanup
}

struct MacNodeScreenRecordParams: Codable, Equatable {
    var operation: MacNodeScreenRecordOperation?
    var artifactId: String?
    var offset: Int?
    var length: Int?
    var screenIndex: Int?
    var appName: String?
    var bundleId: String?
    var windowId: Int?
    var durationMs: Int?
    var fps: Double?
    var format: String?
    var includeAudio: Bool?
}
