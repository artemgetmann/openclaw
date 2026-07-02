import Foundation

public enum OpenClawScreenCommand: String, Codable, Sendable {
    case record = "screen.record"
}

public struct OpenClawScreenRecordParams: Codable, Sendable, Equatable {
    public var screenIndex: Int?
    public var appName: String?
    public var bundleId: String?
    public var windowId: UInt32?
    public var durationMs: Int?
    public var fps: Double?
    public var format: String?
    public var includeAudio: Bool?

    public init(
        screenIndex: Int? = nil,
        appName: String? = nil,
        bundleId: String? = nil,
        windowId: UInt32? = nil,
        durationMs: Int? = nil,
        fps: Double? = nil,
        format: String? = nil,
        includeAudio: Bool? = nil)
    {
        self.screenIndex = screenIndex
        self.appName = appName
        self.bundleId = bundleId
        self.windowId = windowId
        self.durationMs = durationMs
        self.fps = fps
        self.format = format
        self.includeAudio = includeAudio
    }
}
