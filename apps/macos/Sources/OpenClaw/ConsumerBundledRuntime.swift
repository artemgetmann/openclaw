import Darwin
import Foundation
import OSLog

enum ConsumerBundledRuntime {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "consumer.bundled-runtime")

    static let resourceDirectoryName = "OpenClawRuntime"

    private static let openclawPayloadDirectoryName = "openclaw"
    private static let installedPayloadDirectoryName = "openclaw-bundled"
    private static let manifestFileName = "manifest.json"
    private static let installedManifestFileName = ".consumer-bundled-runtime.json"

    struct Manifest: Codable, Equatable {
        let format: Int
        let bundleVersion: String
        let gitCommit: String
        let nodeVersion: String
    }

    enum SeedStatus: Equatable {
        case seeded
        case ready
    }

    static func bootstrapIfNeeded(bundle: Bundle = .main, fileManager: FileManager = .default) {
        guard AppFlavor.current.isConsumer else { return }
        guard let resourceURL = self.resourceURL(bundle: bundle) else { return }

        do {
            let status = try self.seedIfNeeded(
                from: resourceURL,
                into: ConsumerRuntime.installPrefixURL,
                fileManager: fileManager)
            switch status {
            case .seeded:
                self.logger.info("seeded bundled consumer runtime into \(ConsumerRuntime.installPrefixURL.path, privacy: .public)")
            case .ready:
                self.logger.debug("bundled consumer runtime already ready at \(ConsumerRuntime.installPrefixURL.path, privacy: .public)")
            }
        } catch {
            // Startup should keep going and surface the real failure through the
            // existing onboarding/install flow instead of crashing the menu bar app.
            self.logger.error("bundled consumer runtime seed failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func resourceURL(bundle: Bundle = .main) -> URL? {
        let resourceURL = bundle.resourceURL?.appendingPathComponent(self.resourceDirectoryName, isDirectory: true)
        guard let resourceURL, FileManager.default.fileExists(atPath: resourceURL.path) else {
            return nil
        }
        return resourceURL
    }

    static func seedIfNeeded(
        from resourceURL: URL,
        into installPrefixURL: URL,
        fileManager: FileManager = .default) throws -> SeedStatus
    {
        let manifest = try self.loadManifest(from: resourceURL)
        if try self.installationIsCurrent(
            manifest: manifest,
            installPrefixURL: installPrefixURL,
            fileManager: fileManager)
        {
            return .ready
        }

        let stagingRoot = try self.makeStagingRoot(near: installPrefixURL, fileManager: fileManager)
        defer { try? fileManager.removeItem(at: stagingRoot) }

        let stagedOpenClawRoot = stagingRoot
            .appendingPathComponent("lib", isDirectory: true)
            .appendingPathComponent(self.installedPayloadDirectoryName, isDirectory: true)
        let stagedNodeRoot = stagingRoot
            .appendingPathComponent("tools", isDirectory: true)
            .appendingPathComponent("node", isDirectory: true)
        let stagedBinDir = stagingRoot.appendingPathComponent("bin", isDirectory: true)

        try fileManager.createDirectory(at: stagedOpenClawRoot.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: stagedNodeRoot.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: stagedBinDir, withIntermediateDirectories: true)

        // Copy the built OpenClaw payload exactly once into the consumer-owned
        // prefix so the packaged app no longer depends on npm/git/bootstrap UX.
        try fileManager.copyItem(
            at: resourceURL.appendingPathComponent(self.openclawPayloadDirectoryName, isDirectory: true),
            to: stagedOpenClawRoot)
        try fileManager.copyItem(
            at: try self.nodeRuntimeSourceURL(from: resourceURL),
            to: stagedNodeRoot)

        let wrapperURL = stagedBinDir.appendingPathComponent("openclaw")
        try self.writeWrapperScript(at: wrapperURL)
        try self.writeManifest(manifest, to: stagingRoot.appendingPathComponent(self.installedManifestFileName))

        try fileManager.createDirectory(at: installPrefixURL, withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: installPrefixURL.appendingPathComponent("bin", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: installPrefixURL.appendingPathComponent("tools", isDirectory: true),
            withIntermediateDirectories: true)
        try fileManager.createDirectory(
            at: installPrefixURL.appendingPathComponent("lib", isDirectory: true),
            withIntermediateDirectories: true)

        try self.replaceManagedPath(
            at: installPrefixURL.appendingPathComponent("bin/openclaw"),
            with: wrapperURL,
            fileManager: fileManager)
        try self.replaceManagedPath(
            at: installPrefixURL.appendingPathComponent("tools/node", isDirectory: true),
            with: stagedNodeRoot,
            fileManager: fileManager)
        try self.replaceManagedPath(
            at: installPrefixURL.appendingPathComponent("lib/\(self.installedPayloadDirectoryName)", isDirectory: true),
            with: stagedOpenClawRoot,
            fileManager: fileManager)
        try self.replaceManagedPath(
            at: installPrefixURL.appendingPathComponent(self.installedManifestFileName),
            with: stagingRoot.appendingPathComponent(self.installedManifestFileName),
            fileManager: fileManager)

        return .seeded
    }

    private static func installationIsCurrent(
        manifest: Manifest,
        installPrefixURL: URL,
        fileManager: FileManager) throws -> Bool
    {
        let installedManifestURL = installPrefixURL.appendingPathComponent(self.installedManifestFileName)
        guard fileManager.fileExists(atPath: installedManifestURL.path) else { return false }
        let installedManifest = try self.loadManifest(fromFile: installedManifestURL)
        guard installedManifest == manifest else { return false }

        let wrapperURL = installPrefixURL.appendingPathComponent("bin/openclaw")
        let nodeURL = installPrefixURL.appendingPathComponent("tools/node/bin/node")
        let entryURL = installPrefixURL
            .appendingPathComponent("lib", isDirectory: true)
            .appendingPathComponent(self.installedPayloadDirectoryName, isDirectory: true)
            .appendingPathComponent("dist/entry.js")
        let chalkPackageURL = installPrefixURL
            .appendingPathComponent("lib", isDirectory: true)
            .appendingPathComponent(self.installedPayloadDirectoryName, isDirectory: true)
            .appendingPathComponent("node_modules", isDirectory: true)
            .appendingPathComponent("chalk", isDirectory: true)
            .appendingPathComponent("package.json")

        return fileManager.isExecutableFile(atPath: wrapperURL.path)
            && fileManager.isExecutableFile(atPath: nodeURL.path)
            && fileManager.isReadableFile(atPath: entryURL.path)
            && fileManager.isReadableFile(atPath: chalkPackageURL.path)
    }

    private static func loadManifest(from resourceURL: URL) throws -> Manifest {
        try self.loadManifest(fromFile: resourceURL.appendingPathComponent(self.manifestFileName))
    }

    private static func loadManifest(fromFile fileURL: URL) throws -> Manifest {
        let data = try Data(contentsOf: fileURL)
        return try JSONDecoder().decode(Manifest.self, from: data)
    }

    private static func writeManifest(_ manifest: Manifest, to fileURL: URL) throws {
        let data = try JSONEncoder().encode(manifest)
        try data.write(to: fileURL, options: .atomic)
    }

    private static func nodeRuntimeSourceURL(from resourceURL: URL) throws -> URL {
        let arch = try self.currentNodeRuntimeDirectoryName()
        let url = resourceURL
            .appendingPathComponent("node", isDirectory: true)
            .appendingPathComponent(arch, isDirectory: true)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(
                domain: "ConsumerBundledRuntime",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Bundled Node runtime missing for \(arch)."])
        }
        return url
    }

    private static func currentNodeRuntimeDirectoryName() throws -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) {
                String(cString: $0)
            }
        }
        switch machine {
        case "arm64":
            return "darwin-arm64"
        case "x86_64":
            return "darwin-x64"
        default:
            throw NSError(
                domain: "ConsumerBundledRuntime",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Unsupported macOS architecture \(machine)."])
        }
    }

    private static func makeStagingRoot(near installPrefixURL: URL, fileManager: FileManager) throws -> URL {
        let parent = installPrefixURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        let stagingRoot = parent.appendingPathComponent(".openclaw-runtime-seed-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
        return stagingRoot
    }

    private static func writeWrapperScript(at fileURL: URL) throws {
        let script = """
        #!/bin/sh
        set -eu
        SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
        exec "$SCRIPT_DIR/../tools/node/bin/node" "$SCRIPT_DIR/../lib/\(self.installedPayloadDirectoryName)/openclaw.mjs" "$@"
        """
        try script.write(to: fileURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fileURL.path)
    }

    private static func replaceManagedPath(at destinationURL: URL, with sourceURL: URL, fileManager: FileManager) throws {
        if fileManager.fileExists(atPath: destinationURL.path) {
            try fileManager.removeItem(at: destinationURL)
        }
        try fileManager.moveItem(at: sourceURL, to: destinationURL)
    }
}
