import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct BrowserSetupSupportTests {
    @Test func `refresh reports chrome missing when not installed`() async {
        let defaults = self.makeDefaults()
        let model = BrowserSetupModel(
            defaults: defaults,
            detectChromeExecutable: { nil },
            loadProfiles: { [] })

        await model.refresh()

        #expect(model.phase == .chromeMissing)
        #expect(model.isComplete == false)
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
            loadProfiles: { [onlyProfile] })

        await model.refresh()

        #expect(model.phase == .confirm(onlyProfile))
        #expect(model.isComplete == false)
    }

    @Test func `refresh restores persisted profile selection`() async {
        let defaults = self.makeDefaults()
        defaults.set("Profile 4", forKey: browserSelectedChromeProfileIDKey)
        defaults.set("Artem", forKey: browserSelectedChromeProfileNameKey)
        let selected = ChromeProfileCandidate(
            directoryName: "Profile 4",
            displayName: "Artem",
            subtitle: "artem@example.com",
            lastUsedAt: nil,
            isDefaultProfile: false)
        let model = BrowserSetupModel(
            defaults: defaults,
            detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
            loadProfiles: { [selected] })

        await model.refresh()

        #expect(model.phase == .ready(selected))
        #expect(model.isComplete)
        #expect(model.selectedProfileName == "Artem")
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
        let model = BrowserSetupModel(
            defaults: defaults,
            detectChromeExecutable: { URL(fileURLWithPath: "/Applications/Google Chrome.app") },
            loadProfiles: { [personal, work] })

        await model.refresh()
        #expect(model.phase == .choose([personal, work]))

        await model.chooseProfile(work)

        #expect(model.phase == .ready(work))
        #expect(defaults.string(forKey: browserSelectedChromeProfileIDKey) == "Profile 4")
        #expect(defaults.string(forKey: browserSelectedChromeProfileNameKey) == "Artem")
    }

    private func makeDefaults() -> UserDefaults {
        let suiteName = "BrowserSetupSupportTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }
}
