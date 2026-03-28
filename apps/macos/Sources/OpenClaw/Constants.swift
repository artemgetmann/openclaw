import Foundation

func consumerDefaultsKey(_ suffix: String) -> String {
    "\(AppFlavor.current.defaultsPrefix).\(suffix)"
}

private var defaultsPrefix: String { AppFlavor.current.defaultsPrefix }

// Keep runtime/service labels pinned to the consumer runtime authority so this branch
// cannot silently fall back to founder labels when flavor metadata is missing.
var launchdLabel: String { ConsumerRuntime.launchdLabel }
var gatewayLaunchdLabel: String { ConsumerRuntime.gatewayLaunchdLabel }
var onboardingVersionKey: String { "\(defaultsPrefix).onboardingVersion" }
var onboardingSeenKey: String { "\(defaultsPrefix).onboardingSeen" }
let currentOnboardingVersion = 9
var launchAtLoginPreferenceKey: String { "\(defaultsPrefix).launchAtLogin" }
var pauseDefaultsKey: String { "\(defaultsPrefix).pauseEnabled" }
var iconAnimationsEnabledKey: String { "\(defaultsPrefix).iconAnimationsEnabled" }
var swabbleEnabledKey: String { "\(defaultsPrefix).swabbleEnabled" }
var swabbleTriggersKey: String { "\(defaultsPrefix).swabbleTriggers" }
var voiceWakeTriggerChimeKey: String { "\(defaultsPrefix).voiceWakeTriggerChime" }
var voiceWakeSendChimeKey: String { "\(defaultsPrefix).voiceWakeSendChime" }
var showDockIconKey: String { "\(defaultsPrefix).showDockIcon" }
let defaultVoiceWakeTriggers = ["openclaw"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
var voiceWakeMicKey: String { "\(defaultsPrefix).voiceWakeMicID" }
var voiceWakeMicNameKey: String { "\(defaultsPrefix).voiceWakeMicName" }
var voiceWakeLocaleKey: String { "\(defaultsPrefix).voiceWakeLocaleID" }
var voiceWakeAdditionalLocalesKey: String { "\(defaultsPrefix).voiceWakeAdditionalLocaleIDs" }
var voicePushToTalkEnabledKey: String { "\(defaultsPrefix).voicePushToTalkEnabled" }
var talkEnabledKey: String { "\(defaultsPrefix).talkEnabled" }
var iconOverrideKey: String { "\(defaultsPrefix).iconOverride" }
var connectionModeKey: String { "\(defaultsPrefix).connectionMode" }
var remoteTargetKey: String { "\(defaultsPrefix).remoteTarget" }
var remoteIdentityKey: String { "\(defaultsPrefix).remoteIdentity" }
var remoteProjectRootKey: String { "\(defaultsPrefix).remoteProjectRoot" }
var remoteCliPathKey: String { "\(defaultsPrefix).remoteCliPath" }
var canvasEnabledKey: String { "\(defaultsPrefix).canvasEnabled" }
var cameraEnabledKey: String { "\(defaultsPrefix).cameraEnabled" }
var systemRunPolicyKey: String { "\(defaultsPrefix).systemRunPolicy" }
var systemRunAllowlistKey: String { "\(defaultsPrefix).systemRunAllowlist" }
var systemRunEnabledKey: String { "\(defaultsPrefix).systemRunEnabled" }
var locationModeKey: String { "\(defaultsPrefix).locationMode" }
var locationPreciseKey: String { "\(defaultsPrefix).locationPreciseEnabled" }
var peekabooBridgeEnabledKey: String { "\(defaultsPrefix).peekabooBridgeEnabled" }
var deepLinkKeyKey: String { "\(defaultsPrefix).deepLinkKey" }
var modelCatalogPathKey: String { "\(defaultsPrefix).modelCatalogPath" }
var modelCatalogReloadKey: String { "\(defaultsPrefix).modelCatalogReload" }
var cliInstallPromptedVersionKey: String { "\(defaultsPrefix).cliInstallPromptedVersion" }
var heartbeatsEnabledKey: String { "\(defaultsPrefix).heartbeatsEnabled" }
var debugPaneEnabledKey: String { "\(defaultsPrefix).debugPaneEnabled" }
var debugFileLogEnabledKey: String { "\(defaultsPrefix).debug.fileLogEnabled" }
var appLogLevelKey: String { "\(defaultsPrefix).debug.appLogLevel" }
var showAdvancedSettingsKey: String { "\(defaultsPrefix).showAdvancedSettings" }
var browserSelectedChromeProfileIDKey: String { "\(defaultsPrefix).browser.selectedChromeProfileID" }
var browserSelectedChromeProfileNameKey: String { "\(defaultsPrefix).browser.selectedChromeProfileName" }
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
