import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct BrowserSetupSupportTests {
    @Test func `refresh reports chrome missing when not installed`() async {
        let defaults = self.makeDefaults()
        var clearedRuntimeConfig = false
        let model = BrowserSetupModel(
            defaults: defaults,
            detectChromeExecutable: { nil },
            loadProfiles: { [] },
            persistSelectionToConfig: { _ in },
            clearSelectionFromConfig: { clearedRuntimeConfig = true },
            verifySelectionReadiness: { _ in nil })

        await model.refresh()

        #expect(model.phase == .chromeMissing)
        #expect(model.isComplete == false)
        #expect(clearedRuntimeConfig)
    }

    @Test func `refresh confirms single detected profile`() async {
        let defaults = self.makeDefaults()
        let onlyProfile = ChromeProfileCandidate(
            directoryName: "Default",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: true)
        let model = BrowserSetupModel(
            defaults: defaults,
            detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
            loadProfiles: { [onlyProfile] },
            persistSelectionToConfig: { _ in },
            clearSelectionFromConfig: {},
            verifySelectionReadiness: { _ in nil })

        await model.refresh()

        #expect(model.phase == .confirm(onlyProfile))
        #expect(model.isComplete == false)
    }

    @Test func `refresh clears runtime browser config when no profiles are found`() async {
        let defaults = self.makeDefaults()
        var clearedRuntimeConfig = false
        let model = BrowserSetupModel(
            defaults: defaults,
            detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
            loadProfiles: { [] },
            persistSelectionToConfig: { _ in },
            clearSelectionFromConfig: { clearedRuntimeConfig = true },
            verifySelectionReadiness: { _ in nil })

        await model.refresh()

        #expect(model.phase == .noProfiles)
        #expect(clearedRuntimeConfig)
    }

    @Test func `refresh restores persisted profile selection`() async {
        let defaults = self.makeDefaults()
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: "artem@example.com",
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            #expect(OpenClawConfigFile.setSelectedChromeProfileDirectoryName("Profile 4"))

            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [selected] },
                verifySelectionReadiness: { _ in nil })

            await model.refresh()

            #expect(model.phase == .ready(selected))
            #expect(model.isComplete)
            #expect(model.selectedProfileName == "Artem")
            #expect(defaults.string(forKey: browserSelectedChromeProfileIDKey) == "Profile 4")
            #expect(defaults.string(forKey: browserSelectedChromeProfileNameKey) == "Artem")
        }
    }

    @Test func `refresh preserves persisted profile when runtime readiness fails`() async {
        let defaults = self.makeDefaults()
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            defaults.set("Profile 4", forKey: browserSelectedChromeProfileIDKey)
            defaults.set("Artem", forKey: browserSelectedChromeProfileNameKey)
            #expect(OpenClawConfigFile.setSelectedChromeProfileDirectoryName("Profile 4"))

            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [selected] },
                verifySelectionReadiness: { _ in "Chrome is still unavailable." })

            await model.refresh()

            #expect(model.phase == .failed("Chrome is still unavailable."))
            #expect(defaults.string(forKey: browserSelectedChromeProfileIDKey) == "Profile 4")
            #expect(defaults.string(forKey: browserSelectedChromeProfileNameKey) == "Artem")
            #expect(OpenClawConfigFile.selectedChromeProfileDirectoryName() == "Profile 4")
        }
    }

    @Test func `transient browser readiness failure auto-recovers on app activation`() async {
        let defaults = self.makeDefaults()
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        var verificationAttempts = 0

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            defaults.set("Profile 4", forKey: browserSelectedChromeProfileIDKey)
            defaults.set("Artem", forKey: browserSelectedChromeProfileNameKey)
            #expect(OpenClawConfigFile.setSelectedChromeProfileDirectoryName("Profile 4"))

            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [selected] },
                verifySelectionReadiness: { _ in
                    verificationAttempts += 1
                    if verificationAttempts == 1 {
                        return "OpenClaw saved the Chrome profile, but browser readiness failed. command failed"
                    }
                    return nil
                })

            await model.refresh()
            #expect(model.phase == .failed("OpenClaw saved the Chrome profile, but browser readiness failed. command failed"))

            await model.retryTransientFailureIfNeeded()

            #expect(verificationAttempts == 2)
            #expect(model.phase == .ready(selected))
            #expect(model.isComplete)
        }
    }

    @Test func `stable browser readiness failure does not auto-recover on app activation`() async {
        let defaults = self.makeDefaults()
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        var verificationAttempts = 0

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            defaults.set("Profile 4", forKey: browserSelectedChromeProfileIDKey)
            defaults.set("Artem", forKey: browserSelectedChromeProfileNameKey)
            #expect(OpenClawConfigFile.setSelectedChromeProfileDirectoryName("Profile 4"))

            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [selected] },
                verifySelectionReadiness: { _ in
                    verificationAttempts += 1
                    return "OpenClaw saved the wrong Chrome profile. Choose your profile again so browser tasks use the right session."
                })

            await model.refresh()
            #expect(model.phase == .failed("OpenClaw saved the wrong Chrome profile. Choose your profile again so browser tasks use the right session."))

            await model.retryTransientFailureIfNeeded()

            #expect(verificationAttempts == 1)
            #expect(model.phase == .failed("OpenClaw saved the wrong Chrome profile. Choose your profile again so browser tasks use the right session."))
        }
    }

    @Test func `choose profile persists selection and marks ready`() async {
        let defaults = self.makeDefaults()
        let personal = ChromeProfileCandidate(
            directoryName: "Profile 2",
            displayName: "Your Chrome",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let work = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.updateGatewayDict { gateway in
                gateway["port"] = 19001
            }

            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [personal, work] },
                verifySelectionReadiness: { _ in nil })

            await model.refresh()
            #expect(model.phase == .choose([personal, work]))

            await model.chooseProfile(work)

            #expect(model.phase == .ready(work))
            #expect(defaults.string(forKey: browserSelectedChromeProfileIDKey) == "Profile 4")
            #expect(defaults.string(forKey: browserSelectedChromeProfileNameKey) == "Artem")
            #expect(OpenClawConfigFile.selectedChromeProfileDirectoryName() == "Profile 4")

            let root = OpenClawConfigFile.loadDict()
            let browser = root["browser"] as? [String: Any]
            let profiles = browser?["profiles"] as? [String: Any]
            let userProfile = profiles?["user"] as? [String: Any]
            #expect(browser?["defaultProfile"] as? String == "user")
            #expect((userProfile?["cdpPort"] as? NSNumber)?.intValue == OpenClawConfigFile.managedBrowserUserCdpPort())
            #expect(userProfile?["cloneFromUserProfile"] as? Bool == true)
            #expect(userProfile?["sourceProfileName"] as? String == "Profile 4")
            #expect(userProfile?["color"] as? String == "#00AA00")

            let userDataDir = OpenClawConfigFile.managedBrowserUserDataDirURL()
            #expect(FileManager.default.fileExists(atPath: userDataDir.path))
        }
    }

    @Test func `choose profile preserves selection when runtime browser readiness fails`() async {
        let defaults = self.makeDefaults()
        let work = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        var verifiedProfileName: String?
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [work] },
                verifySelectionReadiness: { profile in
                    verifiedProfileName = profile.directoryName
                    return "Chrome is still unavailable."
                })

            await model.refresh()
            await model.chooseProfile(work)

            #expect(model.phase == .failed("Chrome is still unavailable."))
            #expect(model.isComplete == false)
            #expect(defaults.string(forKey: browserSelectedChromeProfileIDKey) == "Profile 4")
            #expect(defaults.string(forKey: browserSelectedChromeProfileNameKey) == "Artem")
            #expect(verifiedProfileName == "Profile 4")
            #expect(OpenClawConfigFile.selectedChromeProfileDirectoryName() == "Profile 4")
        }
    }

    @Test func `consumer browser readiness succeeds without gateway pairing when browser status is ready`() async {
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        var browserStatusCalled = false

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            #expect(OpenClawConfigFile.setSelectedChromeProfileDirectoryName("Profile 4"))
            let payload = """
            {
              "enabled": true,
              "running": false,
              "chosenBrowser": null,
              "detectedBrowser": "chrome",
              "detectedExecutablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "detectError": null
            }
            """

            let result = await BrowserSetupModel.verifyConsumerBrowserSelection(
                expectedProfile: selected,
                runBrowserStatus: { _, _, _ in
                    browserStatusCalled = true
                    return ConsumerShellCommandResult(
                        stdout: payload,
                        stderr: "",
                        exitCode: 0,
                        success: true)
                })

            #expect(browserStatusCalled)
            #expect(result == nil)
            #expect(OpenClawConfigFile.selectedChromeProfileDirectoryName() == "Profile 4")
        }
    }

    @Test func `refresh migrates legacy defaults selection into config`() async {
        let defaults = self.makeDefaults()
        defaults.set("Profile 4", forKey: browserSelectedChromeProfileIDKey)
        defaults.set("Artem", forKey: browserSelectedChromeProfileNameKey)
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.updateGatewayDict { gateway in
                gateway["port"] = 19001
            }

            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [selected] },
                verifySelectionReadiness: { _ in nil })

            await model.refresh()

            #expect(model.phase == .ready(selected))
            #expect(OpenClawConfigFile.selectedChromeProfileDirectoryName() == "Profile 4")
            #expect(FileManager.default.fileExists(atPath: OpenClawConfigFile.managedBrowserUserDataDirURL().path))
        }
    }

    @Test func `clear profile selection removes config backed browser selection`() async {
        let defaults = self.makeDefaults()
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: nil,
            lastUsedAt: nil,
            isDefaultProfile: false)
        let stateDir = try! makeTempDirForTests()
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager.default.removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            let model = BrowserSetupModel(
                defaults: defaults,
                detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
                loadProfiles: { [selected] },
                verifySelectionReadiness: { _ in nil })

            await model.chooseProfile(selected)
            model.clearProfileSelection()

            #expect(defaults.string(forKey: browserSelectedChromeProfileIDKey) == nil)
            #expect(defaults.string(forKey: browserSelectedChromeProfileNameKey) == nil)
            #expect(OpenClawConfigFile.selectedChromeProfileDirectoryName() == nil)

            let root = OpenClawConfigFile.loadDict()
            let browser = root["browser"] as? [String: Any]
            let profiles = browser?["profiles"] as? [String: Any]
            #expect((browser?["defaultProfile"] as? String) == nil)
            #expect(profiles?["user"] == nil)
        }
    }

    private func makeDefaults() -> UserDefaults {
        let suiteName = "BrowserSetupSupportTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }
}
