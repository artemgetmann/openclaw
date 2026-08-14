import Foundation

public enum OpenClawNodeErrorCode: String, Codable, Sendable {
    case notPaired = "NOT_PAIRED"
    case unauthorized = "UNAUTHORIZED"
    case backgroundUnavailable = "NODE_BACKGROUND_UNAVAILABLE"
    case invalidRequest = "INVALID_REQUEST"
    case unavailable = "UNAVAILABLE"
}

public enum OpenClawNodePermission: String, Codable, Sendable {
    case accessibility
    case screenRecording
    case location
    case camera
    case microphone
    case desktop
    case documents
    case downloads
}

public enum OpenClawNodePermissionState: String, Codable, Sendable {
    case notRequested
    case requested
    case requestedStillMissing
    case granted
    case denied
    case unknown
}

public enum OpenClawNodePermissionNextAction: String, Codable, Sendable {
    case approveMacPrompt
    case checkMacForPrompt
    case openSystemSettings
    case openSystemSettingsAndReopen
}

/// Structured permission truth lets every client explain the exact blocker
/// without reverse-engineering prose or claiming that macOS displayed a prompt.
public struct OpenClawNodePermissionError: Codable, Sendable, Equatable {
    public var permission: OpenClawNodePermission
    public var state: OpenClawNodePermissionState
    public var nextAction: OpenClawNodePermissionNextAction

    public init(
        permission: OpenClawNodePermission,
        state: OpenClawNodePermissionState,
        nextAction: OpenClawNodePermissionNextAction)
    {
        self.permission = permission
        self.state = state
        self.nextAction = nextAction
    }
}

public struct OpenClawNodeError: Error, Codable, Sendable, Equatable {
    public var code: OpenClawNodeErrorCode
    public var message: String
    public var retryable: Bool?
    public var retryAfterMs: Int?
    public var permission: OpenClawNodePermissionError?

    public init(
        code: OpenClawNodeErrorCode,
        message: String,
        retryable: Bool? = nil,
        retryAfterMs: Int? = nil,
        permission: OpenClawNodePermissionError? = nil)
    {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retryAfterMs = retryAfterMs
        self.permission = permission
    }
}
