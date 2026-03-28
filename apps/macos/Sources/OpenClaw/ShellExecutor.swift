import Foundation
import OpenClawIPC
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

enum ShellExecutor {
    actor TimeoutState {
        private var triggered = false

        func mark() {
            self.triggered = true
        }

        func isTriggered() -> Bool {
            self.triggered
        }
    }

    struct ShellResult {
        var stdout: String
        var stderr: String
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var errorMessage: String?
    }

    static func runDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?) async -> ShellResult
    {
        guard !command.isEmpty else {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "empty command")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = command
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env { process.environment = env }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "failed to start: \(error.localizedDescription)")
        }

        let outTask = Task { stdoutPipe.fileHandleForReading.readToEndSafely() }
        let errTask = Task { stderrPipe.fileHandleForReading.readToEndSafely() }
        let timeoutState = TimeoutState()

        let waitTask = Task { () -> ShellResult in
            process.waitUntilExit()
            let out = await outTask.value
            let err = await errTask.value
            let status = Int(process.terminationStatus)
            let timedOut = await timeoutState.isTriggered()
            return ShellResult(
                stdout: String(bytes: out, encoding: .utf8) ?? "",
                stderr: String(bytes: err, encoding: .utf8) ?? "",
                exitCode: status,
                timedOut: timedOut,
                success: status == 0 && !timedOut,
                errorMessage: timedOut ? "timeout" : (status == 0 ? nil : "exit \(status)"))
        }

        if let timeout, timeout > 0 {
            let nanos = UInt64(timeout * 1_000_000_000)
            return await withTaskGroup(of: ShellResult.self) { group in
                group.addTask { await waitTask.value }
                group.addTask {
                    try? await Task.sleep(nanoseconds: nanos)
                    await timeoutState.mark()
                    // Some child commands ignore SIGTERM or keep descendants alive
                    // long enough that a naive terminate()+wait can strand callers in
                    // a fake "timeout" that never actually returns.
                    if process.isRunning {
                        process.terminate()
                        try? await Task.sleep(nanoseconds: 750_000_000)
                    }
                    if process.isRunning {
                        kill(process.processIdentifier, SIGKILL)
                    }
                    // Return the timeout immediately. The caller needs the UI to
                    // move on once the command overstays; background cleanup can
                    // finish after we have already reported the timeout.
                    stdoutPipe.fileHandleForReading.readabilityHandler = nil
                    stderrPipe.fileHandleForReading.readabilityHandler = nil
                    try? stdoutPipe.fileHandleForReading.close()
                    try? stderrPipe.fileHandleForReading.close()
                    outTask.cancel()
                    errTask.cancel()
                    return ShellResult(
                        stdout: "",
                        stderr: "",
                        exitCode: nil,
                        timedOut: true,
                        success: false,
                        errorMessage: "timeout")
                }
                let first = await group.next()!
                group.cancelAll()
                return first
            }
        }

        return await waitTask.value
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}
