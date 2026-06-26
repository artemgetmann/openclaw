import { describe, expect, it } from "vitest";
import { evaluateGuiPolicy, getGuiTaskPolicyProfile } from "./policy.js";
import type { GuiSnapshot } from "./types.js";

function snapshot(params: Partial<GuiSnapshot> = {}): GuiSnapshot {
  return {
    id: params.id ?? "s1",
    appName: params.appName ?? "Safari",
    windowTitle: params.windowTitle ?? "Example",
    summary: params.summary ?? "Readable web page",
    visibleText: params.visibleText,
    elements: params.elements ?? [],
  };
}

describe("evaluateGuiPolicy", () => {
  it("allows read-only observation with the read-only web profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "observe",
      target: { appName: "Safari", windowTitle: "X / Home" },
      snapshot: snapshot({ windowTitle: "X / Home" }),
      reason: "Observe a web page without changing it.",
      taskPolicy: getGuiTaskPolicyProfile("read_only_web_context"),
      verificationMode: "observe_only",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("read-only");
    expect(decision.requiredCapability).toBe("read_screen");
  });

  it("blocks mutation when the task lacks the matching capability", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Safari", windowTitle: "Example" },
      snapshot: snapshot(),
      element: { ref: "@input", role: "textbox", label: "Search" },
      reason: "Write text into the current page.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("read_only_web_context"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("lacks capability write_text_to_target");
  });

  it.each([
    ["Jarvis", "About"],
    ["Jarvis", "Permissions"],
    ["Jarvis", "AI access"],
    ["OpenClaw", "Browser"],
  ])(
    "allows safe local settings row navigation for %s / %s when unrelated controls are dangerous",
    (appName, label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName, windowTitle: "Settings" },
        snapshot: snapshot({
          appName,
          windowTitle: "Settings",
          summary: "Settings sidebar with General, Permissions, AI access, Browser, About",
          visibleText: [
            "General",
            "Permissions",
            "AI access",
            "Browser",
            "About",
            "Stop AI Operator",
            "Quit App Only",
          ],
        }),
        element: { ref: `@${label.toLowerCase().replaceAll(" ", "-")}`, role: "row", label },
        reason: `Navigate to the ${label} settings row.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("safe_local_settings_navigation"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(true);
      expect(decision.risk).toBe("allowed-mutation");
      expect(decision.requiredCapability).toBe("click_verified_button");
    },
  );

  it.each(["Stop AI Operator", "Quit App Only", "Destructive Settings"])(
    "blocks dangerous Jarvis settings label %s under the local navigation profile",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "Jarvis", windowTitle: "Settings" },
        snapshot: snapshot({
          appName: "Jarvis",
          windowTitle: "Settings",
          summary: "Jarvis settings",
        }),
        element: { ref: "@danger", role: "button", label },
        reason: `Click ${label}.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("safe_local_settings_navigation"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("Blocked sensitive GUI surface");
    },
  );

  it("allows Google Flights destination writes under the non-committal web dry-run profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: {
        appName: "Safari",
        windowTitle: "Find Cheap Flights Worldwide & Book Your Ticket - Google Flights",
      },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Find Cheap Flights Worldwide & Book Your Ticket - Google Flights",
        summary: "Flight search page showing Denpasar origin and destination field",
      }),
      element: { ref: "@destination", role: "textbox", label: "Where to?" },
      reason: "Set the destination field to Singapore for a dry-run search.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("write_text_to_target");
  });

  it("allows visible Google Flights suggestion-card clicks under the web dry-run profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Google Flights" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Google Flights",
        summary: "Flight search page with visible DPS to SIN suggestion cards",
      }),
      element: { ref: "@suggestion", role: "button", label: "DPS to SIN" },
      reason: "Click the already-visible Google Flights suggestion card.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("click_verified_button");
  });

  it("allows route exploration when the reason documents stop-before boundaries", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: {
        appName: "Safari",
        windowTitle: "Find Cheap Flights Worldwide & Book Your Ticket - Google Flights",
      },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Find Cheap Flights Worldwide & Book Your Ticket - Google Flights",
        summary: "Flight search page with a visible Denpasar to Singapore result",
      }),
      element: {
        ref: "@result",
        role: "button",
        label:
          "Find flights from Denpasar (DPS) to Singapore (SIN) from IDR 2,485,582. Operated by KLM.",
      },
      reason:
        "Open the visible Google Flights Singapore result for route exploration only; stop before booking, passenger, checkout, payment, purchase, or confirmation.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("click_verified_button");
  });

  it.each([
    "Log in",
    "Payment",
    "Passenger details",
    "Traveler details",
    "Checkout",
    "Purchase",
    "Book",
    "Confirm",
    "Card details",
  ])("blocks committal web surface %s under the dry-run profile", (label) => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Google Flights" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Google Flights",
        summary: "Flight search page",
      }),
      element: { ref: "@commit", role: "button", label },
      reason: `Click ${label}.`,
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface");
  });

  it("blocks Google Flights passenger controls under the dry-run profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Google Flights" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Google Flights",
        summary: "Flight search page",
      }),
      element: {
        ref: "@passengers",
        role: "pop up button",
        label: "1 passenger, change number of passengers.",
      },
      reason: "Inspect the passenger menu.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface: passenger");
  });

  it("blocks direct committal intent in the reason even for an ambiguous button", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Cart" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Cart",
        summary: "Shopping flow",
      }),
      element: { ref: "@continue", role: "button", label: "Continue" },
      reason: "Continue to payment.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface: payment");
  });

  it("allows passenger count controls under the commerce-until-final-confirmation profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Find Cheap Flights & Book Your Ticket" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Find Cheap Flights & Book Your Ticket",
        summary: "Flight checkout setup with passenger count controls",
      }),
      element: {
        ref: "@passengers",
        role: "button",
        label: "2 passengers, change number of passengers",
      },
      reason: "Adjust the passenger count without entering payment or final booking.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("click_verified_button");
  });

  it("allows explicitly supplied traveler/contact detail entry under the commerce profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Safari", windowTitle: "Airline traveler details" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Airline traveler details",
        summary: "Traveler detail form",
      }),
      element: { ref: "@email", role: "textbox", label: "Contact email" },
      reason: "Enter the contact email explicitly supplied by the user for this booking flow.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("write_text_to_target");
  });

  it("blocks traveler/contact detail entry when the reason does not say the user supplied it", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Safari", windowTitle: "Traveler details" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Traveler details",
        summary: "Traveler detail form",
      }),
      element: { ref: "@name", role: "textbox", label: "Passenger full name" },
      reason: "Fill the passenger name to continue.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("explicitly supplied by the user");
  });

  it.each([
    {
      windowTitle: "Payment",
      summary: "Payment method required",
      visibleText: [] as string[],
      blockedTerm: "payment",
    },
    {
      windowTitle: "Sign in",
      summary: "Sign in to continue",
      visibleText: [] as string[],
      blockedTerm: "sign in",
    },
    {
      windowTitle: "Checkout",
      summary: "Payment method required",
      visibleText: [] as string[],
      blockedTerm: "payment",
    },
    {
      windowTitle: "Checkout",
      summary: "Checkout step",
      visibleText: ["Sign in to continue"] as string[],
      blockedTerm: "sign in",
    },
    {
      windowTitle: "Checkout",
      summary: "Review and confirm order",
      visibleText: [] as string[],
      blockedTerm: "review and confirm",
    },
    {
      windowTitle: "Checkout",
      summary: "Checkout step",
      visibleText: ["Final confirmation"] as string[],
      blockedTerm: "final confirmation",
    },
    {
      windowTitle: "Checkout",
      summary: "Checkout step",
      visibleText: ["Pay with Visa"] as string[],
      blockedTerm: "pay",
    },
    {
      windowTitle: "Checkout",
      summary: "Checkout step",
      visibleText: ["Apple Pay"] as string[],
      blockedTerm: "apple pay",
    },
    {
      windowTitle: "Checkout",
      summary: "Checkout step",
      visibleText: ["PayPal"] as string[],
      blockedTerm: "paypal",
    },
    {
      windowTitle: "Delete account",
      summary: "Account deletion step",
      visibleText: [] as string[],
      blockedTerm: "delete account",
    },
    {
      windowTitle: "Checkout",
      summary: "Switch account before continuing",
      visibleText: [] as string[],
      blockedTerm: "switch account",
    },
  ])(
    "blocks generic commerce controls on hard-stop $blockedTerm context",
    ({ windowTitle, summary, visibleText, blockedTerm }) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "Safari", windowTitle },
        snapshot: snapshot({
          appName: "Safari",
          windowTitle,
          summary,
          visibleText,
        }),
        element: { ref: "@continue", role: "button", label: "Continue" },
        reason: "Continue this reversible commerce flow without entering payment or final booking.",
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain(`Blocked sensitive GUI context: ${blockedTerm}`);
    },
  );

  it("blocks visible payment-method instructions even when phrased as before-you-continue copy", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Checkout" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Checkout",
        summary: "Checkout step",
        visibleText: ["Before you continue, add a payment method"],
      }),
      element: { ref: "@continue", role: "button", label: "Continue" },
      reason: "Continue this reversible commerce flow without entering payment or final booking.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI context: payment");
  });

  it.each(["Given name", "Surname", "Date of birth", "Mobile number"])(
    "blocks traveler detail field %s without explicit user-supplied source",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "setValue",
        target: { appName: "Safari", windowTitle: "Traveler details" },
        snapshot: snapshot({
          appName: "Safari",
          windowTitle: "Traveler details",
          summary: "Traveler detail form",
        }),
        element: { ref: "@field", role: "textbox", label },
        reason: `Fill the ${label}.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("explicitly supplied by the user");
    },
  );

  it.each([
    "Payment method",
    "Credit card number",
    "Card details",
    "Pay now",
    "Book",
    "Confirm",
    "Order",
    "Order now",
    "Reserve",
    "Place order",
    "Confirm booking",
    "Buy now",
    "Purchase",
    "Subscribe",
    "Upgrade",
    "Start trial",
    "Start free trial",
    "OTP verification",
    "Password",
    "Security settings",
    "Cancel booking",
    "Refund order",
  ])("blocks commerce final, payment, auth, security, or destructive surface %s", (label) => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Checkout" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Checkout",
        summary: "Checkout flow",
      }),
      element: { ref: "@blocked", role: "button", label },
      reason: `Click ${label}.`,
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface");
  });

  it.each(["Select fare", "Add to cart", "Continue to checkout", "Use this shipping address"])(
    "allows reversible commerce progress %s before final confirmation",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "Safari", windowTitle: "Checkout setup" },
        snapshot: snapshot({
          appName: "Safari",
          windowTitle: "Checkout setup",
          summary: "Commerce setup",
        }),
        element: { ref: "@continue", role: "button", label },
        reason: `Click ${label} without entering a payment method or final charge step.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(true);
      expect(decision.risk).toBe("allowed-mutation");
    },
  );

  it("allows checkout continuation when cart context contains an unrelated remove link", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Cart" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Cart",
        summary: "Cart has an item remove link",
        visibleText: ["Item A", "Remove", "Continue to checkout"],
      }),
      element: { ref: "@continue", role: "button", label: "Continue to checkout" },
      reason: "Click Continue to checkout without entering a payment method or final charge step.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
  });

  it.each([
    "Continue to payment without entering card details.",
    "Continue to pay without entering card details.",
    "Go to final booking without paying.",
    "Click Subscribe to start the plan.",
    "Book this ticket without entering payment.",
    "Click Book flight, not pay yet.",
    "Reserve this flight without payment.",
    "Confirm the booking without paying yet.",
  ])(
    "blocks reasons that proceed to payment/final booking even with negative clauses: %s",
    (reason) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "Safari", windowTitle: "Checkout setup" },
        snapshot: snapshot({
          appName: "Safari",
          windowTitle: "Checkout setup",
          summary: "Commerce setup",
        }),
        element: { ref: "@continue", role: "button", label: "Continue" },
        reason,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("Blocked sensitive GUI surface");
    },
  );

  it("allows Check for Updates under the generic software-update profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Jarvis", windowTitle: "About" },
      snapshot: snapshot({
        appName: "Jarvis",
        windowTitle: "About",
        summary: "About view with update status",
      }),
      element: { ref: "@check", role: "button", label: "Check for Updates" },
      reason: "Check whether a software update is available without installing it.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("software_update_flow"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("click_verified_button");
  });

  it.each([
    "Install Update",
    "Install on Quit",
    "Install and Relaunch",
    "Download and Install",
    "Download & Install",
    "Download/Install",
    "Update Now",
    "Relaunch to Update",
    "Skip This Version",
    "Remind Me Later",
  ])(
    "blocks software update final install/relaunch control %s without higher-trust approval",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "ExampleApp", windowTitle: "Software Update" },
        snapshot: snapshot({
          appName: "ExampleApp",
          windowTitle: "Software Update",
          summary: "Update dialog",
        }),
        element: { ref: "@install", role: "button", label },
        reason: `Click ${label}.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("software_update_flow"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/Blocked sensitive GUI surface|discovery only allows/);
    },
  );

  it.each(["Install Update", "Install on Quit", "Install and Relaunch", "Install Now"])(
    "allows explicitly approved software update install control %s under the install-approved profile",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "ExampleApp", windowTitle: "Software Update" },
        snapshot: snapshot({
          appName: "ExampleApp",
          windowTitle: "Software Update",
          summary: "Update dialog",
        }),
        element: { ref: "@install", role: "button", label },
        reason: `Click ${label} after explicit user approval for this visible app update.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("software_update_install_approved"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(true);
      expect(decision.risk).toBe("allowed-mutation");
      expect(decision.requiredCapability).toBe("click_verified_button");
    },
  );

  it("requires explicit mutation approval even under the software update install-approved profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "ExampleApp", windowTitle: "Software Update" },
      snapshot: snapshot({
        appName: "ExampleApp",
        windowTitle: "Software Update",
        summary: "Update dialog",
      }),
      element: { ref: "@install", role: "button", label: "Install and Relaunch" },
      reason: "Click Install and Relaunch.",
      approvedPolicyRisk: false,
      taskPolicy: getGuiTaskPolicyProfile("software_update_install_approved"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("requires explicit task approval");
  });

  it("blocks generic installer controls under the software update install-approved profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Browser extension installer" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Browser extension installer",
        summary: "Extension installer",
      }),
      element: { ref: "@install", role: "button", label: "Install" },
      reason: "Click Install after explicit user approval.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("software_update_install_approved"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("visible software-update context");
  });

  it("does not let an install-labeled control provide its own updater context", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Browser extension installer" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Browser extension installer",
        summary: "Extension installer",
      }),
      element: { ref: "@install", role: "button", label: "Install Update" },
      reason: "Click Install Update after explicit user approval.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("software_update_install_approved"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("visible software-update context");
  });

  it("does not treat generic release notes as software update install context", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Browser extension installer" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Browser extension installer",
        summary: "Extension installer with release notes",
        visibleText: ["Release notes"],
      }),
      element: { ref: "@install", role: "button", label: "Install" },
      reason: "Click Install after explicit user approval.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("software_update_install_approved"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("visible software-update context");
  });

  it.each(["Skip This Version", "Remind Me Later", "View Later"])(
    "blocks updater preference control %s under the install-approved profile",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "ExampleApp", windowTitle: "Software Update" },
        snapshot: snapshot({
          appName: "ExampleApp",
          windowTitle: "Software Update",
          summary: "Update dialog",
        }),
        element: { ref: "@preference", role: "button", label },
        reason: `Click ${label} after explicit user approval for this visible app update.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("software_update_install_approved"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("only allows install or relaunch controls");
    },
  );

  it.each([
    "Download and Install",
    "Download & Install",
    "Download/Install",
    "Update Now",
    "Relaunch to Update",
    "Replace App",
    "Move to Applications",
  ])(
    "keeps broader software update controls blocked under the install-approved profile: %s",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "ExampleApp", windowTitle: "Software Update" },
        snapshot: snapshot({
          appName: "ExampleApp",
          windowTitle: "Software Update",
          summary: "Update dialog",
        }),
        element: { ref: "@install", role: "button", label },
        reason: `Click ${label} after explicit user approval for this visible app update.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("software_update_install_approved"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("Blocked sensitive GUI surface");
    },
  );

  it.each([
    "Install Update",
    "Install Now",
    "Install and Relaunch",
    "Relaunch to Update",
    "Stop AI Operator",
    "Quit App Only",
  ])("keeps safe settings profile blocking update/operator final controls %s", (label) => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Jarvis", windowTitle: "Settings" },
      snapshot: snapshot({
        appName: "Jarvis",
        windowTitle: "Settings",
        summary: "Jarvis settings",
      }),
      element: { ref: "@danger", role: "button", label },
      reason: `Click ${label}.`,
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("safe_local_settings_navigation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface");
  });

  it("blocks generic sensitive surfaces before capability approval can bypass them", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({
        appName: "Claude",
        windowTitle: "Claude",
        summary: "Account settings include billing and delete controls",
      }),
      element: { ref: "@billing", role: "button", label: "Billing" },
      reason: "Click billing settings.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface");
  });

  it("does not block a safe mutation because unrelated snapshot chrome says remove", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({
        appName: "Claude",
        windowTitle: "Claude",
        summary: "Composer ready. Toolbar secondary action: Remove from toolbar.",
        visibleText: ["Write your prompt to Claude", "Remove from toolbar"],
      }),
      element: {
        ref: "@input",
        role: "text entry area",
        label: "Write your prompt to Claude",
        description: "Write your prompt to Claude",
        value: "Write a message…",
      },
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
  });

  it("allows approved assistant message submission with post-state verification", () => {
    const decision = evaluateGuiPolicy({
      actionType: "press",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({ appName: "Claude", windowTitle: "Claude", summary: "Composer ready" }),
      reason: "Submit a Claude message.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("submit_message_to_target");
  });

  it("blocks target app mismatch against the task policy", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Telegram", windowTitle: "Telegram" },
      snapshot: snapshot({ appName: "Telegram", windowTitle: "Telegram" }),
      element: { ref: "@input", role: "textbox", label: "Message" },
      reason: "Write to an assistant composer.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("does not allow app Telegram");
  });

  it("allows approved Apple Notes writes with the Notes policy", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Notes", windowTitle: "Notes" },
      snapshot: snapshot({ appName: "Notes", windowTitle: "Notes", summary: "Note body ready" }),
      element: { ref: "@note-body", role: "textArea", label: "Note body" },
      reason: "Write approved benchmark text into Apple Notes.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("notes_write"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("write_text_to_target");
  });

  it("does not let the Notes policy write to assistant apps", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({ appName: "Claude", windowTitle: "Claude", summary: "Composer ready" }),
      element: { ref: "@input", role: "textfield", label: "Write your prompt to Claude" },
      reason: "Write benchmark text into Claude.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("notes_write"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("does not allow app Claude");
  });
});
