import AVFoundation
import Foundation
import OpenClawKit
import OSLog
@preconcurrency import ScreenCaptureKit

@MainActor
final class ScreenRecordService {
    enum ScreenRecordError: LocalizedError {
        case noDisplays
        case invalidScreenIndex(Int)
        case noMatchingTarget(String)
        case noFramesCaptured
        case writeFailed(String)

        var errorDescription: String? {
            switch self {
            case .noDisplays:
                "No displays available for screen recording"
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case let .noMatchingTarget(target):
                "No matching screen recording target: \(target)"
            case .noFramesCaptured:
                "No frames captured"
            case let .writeFailed(msg):
                msg
            }
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "screenRecord")

    func record(
        screenIndex: Int?,
        appName: String?,
        bundleId: String?,
        windowId: UInt32?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)
    {
        let durationMs = CaptureRateLimits.clampDurationMs(durationMs)
        let fps = CaptureRateLimits.clampFps(fps, maxFps: 60)
        let includeAudio = includeAudio ?? false

        let outURL: URL = {
            if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return URL(fileURLWithPath: outPath)
            }
            return FileManager().temporaryDirectory
                .appendingPathComponent("openclaw-screen-record-\(UUID().uuidString).mp4")
        }()
        try? FileManager().removeItem(at: outURL)

        let content = try await SCShareableContent.current
        let plan = try self.resolveCapturePlan(
            content: content,
            screenIndex: screenIndex,
            appName: appName,
            bundleId: bundleId,
            windowId: windowId)

        let config = SCStreamConfiguration()
        config.width = plan.width
        config.height = plan.height
        config.queueDepth = 8
        config.showsCursor = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, Int32(fps.rounded()))))
        if includeAudio {
            config.capturesAudio = true
        }

        let recorder = try StreamRecorder(
            outputURL: outURL,
            width: plan.width,
            height: plan.height,
            includeAudio: includeAudio,
            logger: self.logger)

        let stream = SCStream(filter: plan.filter, configuration: config, delegate: recorder)
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)
        if includeAudio {
            try stream.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: recorder.queue)
        }

        self.logger.info(
            "screen record start target=\(plan.label, privacy: .public) durationMs=\(durationMs) fps=\(fps) out=\(outURL.path, privacy: .public)")

        var started = false
        do {
            try await stream.startCapture()
            started = true
            try await Task.sleep(nanoseconds: UInt64(durationMs) * 1_000_000)
            try await stream.stopCapture()
        } catch {
            if started { try? await stream.stopCapture() }
            throw error
        }

        try await recorder.finish()
        return (path: outURL.path, hasAudio: recorder.hasAudio)
    }

    private struct CapturePlan {
        var filter: SCContentFilter
        var width: Int
        var height: Int
        var label: String
    }

    private func resolveCapturePlan(
        content: SCShareableContent,
        screenIndex: Int?,
        appName: String?,
        bundleId: String?,
        windowId: UInt32?) throws -> CapturePlan
    {
        if let windowId {
            guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
                throw ScreenRecordError.noMatchingTarget("window-id=\(windowId)")
            }
            return self.windowCapturePlan(window, label: "window-id=\(windowId)")
        }

        if let requested = Self.trimmed(appName) ?? Self.trimmed(bundleId) {
            let windows = self.matchingWindows(content: content, appName: appName, bundleId: bundleId)
            guard let window = Self.pickBestWindow(windows) else {
                throw ScreenRecordError.noMatchingTarget(requested)
            }
            let app = window.owningApplication
            let label = [
                app?.applicationName,
                app?.bundleIdentifier,
                window.title,
            ]
            .compactMap(Self.trimmed)
            .joined(separator: " · ")
            return self.windowCapturePlan(window, label: label.isEmpty ? requested : label)
        }

        let displays = content.displays.sorted { $0.displayID < $1.displayID }
        guard !displays.isEmpty else { throw ScreenRecordError.noDisplays }

        let idx = screenIndex ?? 0
        guard idx >= 0, idx < displays.count else { throw ScreenRecordError.invalidScreenIndex(idx) }
        let display = displays[idx]
        return CapturePlan(
            filter: SCContentFilter(display: display, excludingWindows: []),
            width: display.width,
            height: display.height,
            label: "display-index=\(idx)")
    }

    private func matchingWindows(
        content: SCShareableContent,
        appName: String?,
        bundleId: String?) -> [SCWindow]
    {
        let requestedName = Self.trimmed(appName)?.lowercased()
        let requestedBundle = Self.trimmed(bundleId)?.lowercased()
        return content.windows.filter { window in
            guard let app = window.owningApplication else { return false }
            if let requestedBundle, app.bundleIdentifier.lowercased() == requestedBundle {
                return true
            }
            if let requestedName {
                let appName = app.applicationName.lowercased()
                let bundle = app.bundleIdentifier.lowercased()
                return appName == requestedName || bundle == requestedName
            }
            return false
        }
    }

    private func windowCapturePlan(_ window: SCWindow, label: String) -> CapturePlan {
        let frame = window.frame
        let width = max(1, Int(frame.width.rounded(.up)))
        let height = max(1, Int(frame.height.rounded(.up)))
        return CapturePlan(
            filter: SCContentFilter(desktopIndependentWindow: window),
            width: width,
            height: height,
            label: label)
    }

    private static func pickBestWindow(_ windows: [SCWindow]) -> SCWindow? {
        windows
            .filter { $0.isOnScreen && $0.frame.width > 0 && $0.frame.height > 0 }
            .sorted {
                if $0.isActive != $1.isActive { return $0.isActive && !$1.isActive }
                let lhsArea = $0.frame.width * $0.frame.height
                let rhsArea = $1.frame.width * $1.frame.height
                return lhsArea > rhsArea
            }
            .first
    }

    private static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

private final class StreamRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "ai.openclaw.screenRecord.writer")

    private let logger: Logger
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    let hasAudio: Bool

    private var started = false
    private var sawFrame = false
    private var didFinish = false
    private var pendingErrorMessage: String?

    init(outputURL: URL, width: Int, height: Int, includeAudio: Bool, logger: Logger) throws {
        self.logger = logger
        self.writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]
        self.input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        self.input.expectsMediaDataInRealTime = true

        guard self.writer.canAdd(self.input) else {
            throw ScreenRecordService.ScreenRecordError.writeFailed("Cannot add video input")
        }
        self.writer.add(self.input)

        if includeAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 1,
                AVSampleRateKey: 44100,
                AVEncoderBitRateKey: 96000,
            ]
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            audioInput.expectsMediaDataInRealTime = true
            if self.writer.canAdd(audioInput) {
                self.writer.add(audioInput)
                self.audioInput = audioInput
                self.hasAudio = true
            } else {
                self.audioInput = nil
                self.hasAudio = false
            }
        } else {
            self.audioInput = nil
            self.hasAudio = false
        }
        super.init()
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        self.queue.async {
            let msg = String(describing: error)
            self.pendingErrorMessage = msg
            self.logger.error("screen record stream stopped with error: \(msg, privacy: .public)")
            _ = stream
        }
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType)
    {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        // Callback runs on `sampleHandlerQueue` (`self.queue`).
        switch type {
        case .screen:
            self.handleVideo(sampleBuffer: sampleBuffer)
        case .audio:
            self.handleAudio(sampleBuffer: sampleBuffer)
        case .microphone:
            break
        @unknown default:
            break
        }
        _ = stream
    }

    private func handleVideo(sampleBuffer: CMSampleBuffer) {
        if let msg = self.pendingErrorMessage {
            self.logger.error("screen record aborting due to prior error: \(msg, privacy: .public)")
            return
        }
        if self.didFinish { return }

        if !self.started {
            guard self.writer.startWriting() else {
                self.pendingErrorMessage = self.writer.error?.localizedDescription ?? "Failed to start writer"
                return
            }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            self.writer.startSession(atSourceTime: pts)
            self.started = true
        }

        self.sawFrame = true
        if self.input.isReadyForMoreMediaData {
            _ = self.input.append(sampleBuffer)
        }
    }

    private func handleAudio(sampleBuffer: CMSampleBuffer) {
        guard let audioInput else { return }
        if let msg = self.pendingErrorMessage {
            self.logger.error("screen record audio aborting due to prior error: \(msg, privacy: .public)")
            return
        }
        if self.didFinish || !self.started { return }
        if audioInput.isReadyForMoreMediaData {
            _ = audioInput.append(sampleBuffer)
        }
    }

    func finish() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.queue.async {
                if let msg = self.pendingErrorMessage {
                    cont.resume(throwing: ScreenRecordService.ScreenRecordError.writeFailed(msg))
                    return
                }
                guard self.started, self.sawFrame else {
                    cont.resume(throwing: ScreenRecordService.ScreenRecordError.noFramesCaptured)
                    return
                }
                if self.didFinish {
                    cont.resume()
                    return
                }
                self.didFinish = true

                self.input.markAsFinished()
                self.audioInput?.markAsFinished()
                self.writer.finishWriting {
                    if let err = self.writer.error {
                        cont
                            .resume(throwing: ScreenRecordService.ScreenRecordError
                                .writeFailed(err.localizedDescription))
                    } else if self.writer.status != .completed {
                        cont
                            .resume(throwing: ScreenRecordService.ScreenRecordError
                                .writeFailed("Failed to finalize video"))
                    } else {
                        cont.resume()
                    }
                }
            }
        }
    }
}
