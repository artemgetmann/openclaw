import Foundation

enum CLIShimOwnership {
    enum Status: Equatable {
        case missing
        case managed
        case unknown(String)
    }

    struct Inspection: Equatable {
        let path: String
        let status: Status
    }

    private static let markerLine = "# jarvis-managed-cli-shim: openclaw-consumer-runtime-v1"

    static func managedWrapperScript(payloadDirectoryName: String) -> String {
        """
        #!/bin/sh
        \(self.markerLine)
        set -eu
        SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
        exec "$SCRIPT_DIR/../tools/node/bin/node" "$SCRIPT_DIR/../lib/\(payloadDirectoryName)/openclaw.mjs" "$@"
        """
    }

    static func inspect(
        at fileURL: URL,
        payloadDirectoryName: String,
        fileManager: FileManager)
        -> Inspection
    {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) else {
            return Inspection(path: fileURL.path, status: .missing)
        }

        guard !isDirectory.boolValue else {
            return Inspection(
                path: fileURL.path,
                status: .unknown("a directory exists at the CLI path"))
        }

        guard let data = fileManager.contents(atPath: fileURL.path),
              let script = String(data: data, encoding: .utf8)
        else {
            return Inspection(
                path: fileURL.path,
                status: .unknown("the existing CLI could not be read"))
        }

        // New shims carry an explicit marker. Legacy Jarvis/OpenClaw packaged
        // shims did not, so we also accept the exact wrapper body this app wrote
        // before the marker existed. Anything else belongs to the user until a
        // force/confirmation flow says otherwise.
        if script.contains(self.markerLine)
            || self.sameScript(script, self.legacyManagedWrapperScript(payloadDirectoryName: payloadDirectoryName))
        {
            return Inspection(path: fileURL.path, status: .managed)
        }

        return Inspection(
            path: fileURL.path,
            status: .unknown("the existing CLI is not a Jarvis-managed shim"))
    }

    static func conflictMessage(for inspection: Inspection) -> String {
        """
        Jarvis found an existing CLI at \(inspection.path) that it does not own, so it did not replace it. Keep the existing CLI, choose another Jarvis CLI location, or use an explicit replace/--force flow after confirming Jarvis should own that path.
        """
    }

    private static func legacyManagedWrapperScript(payloadDirectoryName: String) -> String {
        """
        #!/bin/sh
        set -eu
        SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
        exec "$SCRIPT_DIR/../tools/node/bin/node" "$SCRIPT_DIR/../lib/\(payloadDirectoryName)/openclaw.mjs" "$@"
        """
    }

    private static func sameScript(_ lhs: String, _ rhs: String) -> Bool {
        lhs.trimmingCharacters(in: .whitespacesAndNewlines)
            == rhs.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
