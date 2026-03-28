import Foundation

func makeTempDirForTests() throws -> URL {
    let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
    FileManager().createFile(
        atPath: dir.appendingPathComponent("openclaw.mjs").path,
        contents: Data("// test repo marker\n".utf8))
    FileManager().createFile(
        atPath: dir.appendingPathComponent("package.json").path,
        contents: Data("{\"name\":\"openclaw-test\"}\n".utf8))
    return dir
}

func makeExecutableForTests(at path: URL) throws {
    try FileManager().createDirectory(
        at: path.deletingLastPathComponent(),
        withIntermediateDirectories: true)
    FileManager().createFile(atPath: path.path, contents: Data("echo ok\n".utf8))
    try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
}
