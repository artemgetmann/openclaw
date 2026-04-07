import { describe, expect, it } from "vitest";
import {
  classifyGoogleAuthFailure,
  DEFAULT_CONSUMER_GOOGLE_SERVICES,
} from "../../skills/gog/scripts/gog-auth-local.ts";

describe("gog auth local helper", () => {
  it("defaults consumer Google setup to the broad workspace surface bundle", () => {
    expect(DEFAULT_CONSUMER_GOOGLE_SERVICES).toBe("gmail,calendar,drive,contacts,docs,sheets");
  });

  it("classifies missing Google test-user access clearly", () => {
    const result = classifyGoogleAuthFailure({
      combinedText:
        "Error 403: access_denied. The developer hasn't given you access to this app. This app is in testing.",
      email: "demo@example.com",
      hasAuthUrl: true,
    });

    expect(result.diagnosticKind).toBe("oauth_test_user_missing");
    expect(result.message).toContain("demo@example.com");
    expect(result.nextStep).toContain("test user");
  });

  it("classifies disabled Google APIs clearly", () => {
    const result = classifyGoogleAuthFailure({
      combinedText:
        "Google Drive API has not been used in project 123 before or it is disabled. Enable it by visiting the Google Cloud Console.",
      email: "demo@example.com",
      hasAuthUrl: false,
    });

    expect(result.diagnosticKind).toBe("api_not_enabled");
    expect(result.nextStep).toContain("Enable");
  });

  it("classifies local callback misses after consent", () => {
    const result = classifyGoogleAuthFailure({
      combinedText: "",
      email: "demo@example.com",
      hasAuthUrl: true,
      exitedSuccessfullyWithoutVerification: true,
    });

    expect(result.diagnosticKind).toBe("callback_missed");
    expect(result.message).toContain("could not confirm the local callback");
    expect(result.nextStep).toContain("Reopen");
  });

  it("classifies keychain approval blockers clearly", () => {
    const result = classifyGoogleAuthFailure({
      combinedText:
        "User interaction is not allowed. SecurityAgent could not unlock the keychain item.",
      email: "demo@example.com",
      hasAuthUrl: false,
    });

    expect(result.diagnosticKind).toBe("keychain_approval_needed");
    expect(result.nextStep).toContain("Keychain");
  });
});
