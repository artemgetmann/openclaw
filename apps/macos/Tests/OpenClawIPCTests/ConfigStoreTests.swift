import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConfigStoreTests {
    @Test func `load uses remote in remote mode`() async {
        var localHit = false
        var remoteHit = false
        await TestIsolation.withConfigStoreOverrides(.init(
            isRemoteMode: { true },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))
        {
            let result = await ConfigStore.load()
            #expect(remoteHit)
            #expect(!localHit)
            #expect(result["remote"] as? Bool == true)
        }
    }

    @Test func `load uses local in local mode`() async {
        var localHit = false
        var remoteHit = false
        await TestIsolation.withConfigStoreOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))
        {
            let result = await ConfigStore.load()
            #expect(localHit)
            #expect(!remoteHit)
            #expect(result["local"] as? Bool == true)
        }
    }

    @Test func `save routes to remote in remote mode`() async throws {
        var localHit = false
        var remoteHit = false
        try await TestIsolation.withConfigStoreOverrides(.init(
            isRemoteMode: { true },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))
        {
            try await ConfigStore.save(["remote": true])
            #expect(remoteHit)
            #expect(!localHit)
        }
    }

    @Test func `save routes to local in local mode`() async throws {
        var localHit = false
        var remoteHit = false
        try await TestIsolation.withConfigStoreOverrides(.init(
            isRemoteMode: { false },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))
        {
            try await ConfigStore.save(["local": true])
            #expect(localHit)
            #expect(!remoteHit)
        }
    }
}
