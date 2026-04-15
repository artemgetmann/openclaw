import Foundation
@testable import OpenClaw

enum BundledRuntimeFixtureHelper {
    private static let requiredNodeEntitlementsPlist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>com.apple.security.cs.allow-jit</key>
        <true/>
        <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
        <true/>
    </dict>
    </plist>
    """

    static func writeMinimalBundledRuntime(
        into bundledRoot: URL,
        manifest: ConsumerBundledRuntime.Manifest,
        fileManager: FileManager = .default) throws
    {
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/dist", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("openclaw/node_modules/chalk", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("node/darwin-arm64/bin", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("node/darwin-x64/bin", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("uv/darwin-arm64/bin", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: bundledRoot.appendingPathComponent("uv/darwin-x64/bin", isDirectory: true),
            withIntermediateDirectories: true)

        try JSONEncoder().encode(manifest).write(to: bundledRoot.appendingPathComponent("manifest.json"))
        try "export {}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/openclaw.mjs"),
            atomically: true,
            encoding: .utf8)
        try "{\"name\":\"openclaw\"}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/package.json"),
            atomically: true,
            encoding: .utf8)
        try "export {}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/dist/entry.js"),
            atomically: true,
            encoding: .utf8)
        try "{\"name\":\"chalk\"}\n".write(
            to: bundledRoot.appendingPathComponent("openclaw/node_modules/chalk/package.json"),
            atomically: true,
            encoding: .utf8)

        for arch in ["darwin-arm64", "darwin-x64"] {
            try self.writeSignedNodeBinary(
                to: bundledRoot.appendingPathComponent("node/\(arch)/bin/node"),
                fileManager: fileManager)
            let uvURL = bundledRoot.appendingPathComponent("uv/\(arch)/bin/uv")
            try "#!/bin/sh\necho uv \(manifest.uvVersion)\n".write(
                to: uvURL,
                atomically: true,
                encoding: .utf8)
            try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: uvURL.path)
        }
    }

    private static func writeSignedNodeBinary(to destinationURL: URL, fileManager: FileManager) throws {
        // Use a real Mach-O binary in fixtures so the consumer runtime's
        // codesign verification exercises the same path as production installs.
        try fileManager.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: destinationURL)

        let tempDir = destinationURL.deletingLastPathComponent()
        let entitlementsURL = tempDir.appendingPathComponent(".node-entitlements-\(UUID().uuidString).plist")
        defer { try? fileManager.removeItem(at: entitlementsURL) }
        try Self.requiredNodeEntitlementsPlist.write(to: entitlementsURL, atomically: true, encoding: .utf8)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = [
            "--force",
            "--sign",
            "-",
            "--timestamp=none",
            "--entitlements",
            entitlementsURL.path,
            destinationURL.path,
        ]

        let stderrPipe = Pipe()
        process.standardError = stderrPipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let stderrData = try stderrPipe.fileHandleForReading.readToEnd() ?? Data()
            let stderr = String(data: stderrData, encoding: .utf8) ?? ""
            throw NSError(
                domain: "BundledRuntimeFixtureHelper",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "codesign failed for test node fixture: \(stderr)"])
        }
    }
}
