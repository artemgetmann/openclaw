import { describe, expect, it } from "vitest";
import { detectImageReferences } from "../agents/pi-embedded-runner/run/images.js";
import { buildMonitorWakeMessage } from "./wake.js";

describe("buildMonitorWakeMessage", () => {
  it("keeps checkpoint media references out of the wake prompt without mutating checkpoint state", () => {
    const checkpoint = {
      id: "checkpoint-dld-91f",
      checkedAt: "2026-07-13T01:23:45.000Z",
      chatTarget: "+971507664706",
      summary: "Feedback was confirmed and the conversation remains resolved.",
      evidence: {
        screenshotId: "screenshot-record-17",
        feedbackConfirmationScreenshot:
          "/Users/test/Library/Application Support/OpenClaw/media/91f-proof.jpg",
        attachments: [
          "file:///Users/test/Pictures/follow-up.png",
          "Proof is file:///Users/test/proofs/final proof.png after review.",
          "Single proof '~/Application Support/proof image.png' remains reviewed.",
          "Backtick proof `../Application Support/backtick proof.jpeg` remains reviewed.",
          'Double proof "./Application Support/double proof.webp" remains reviewed.',
          "Bare tilde ~proof.png remains reviewed.",
          "Parenthesized (~proof-two.jpeg) remains reviewed.",
          "https://cdn.example.com/proofs/confirmation.webp?version=2",
          "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
        ],
        structuredMarkers: [
          "[Image: source: /Users/test/proofs/feedback confirmation.png]",
          "[Image: source: file:///Users/test/proofs/follow up.jpeg]",
          "[Image: source: https://cdn.example.com/proofs/final confirmation.webp]",
          "[media attached: /Users/test/proofs/media attachment.tiff (image/tiff)]",
        ],
        nativeImage: {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        },
        nestedImage: {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "nested-image-base64-payload",
          },
        },
        generatedImage: {
          type: "image",
          source: {
            mediaType: "image/webp",
            b64_json: "generated-image-b64-json-payload",
          },
        },
        standaloneImageSource: {
          type: "base64",
          media_type: "image/jpeg",
          data: "snake-case-image-base64-payload",
        },
        byteArrayImage: {
          type: "image",
          mimeType: "image/png",
          data: [137, 80, 78, 71],
        },
        serializedBufferImage: {
          type: "image",
          source: {
            mediaType: "image/png",
            data: { type: "Buffer", data: [137, 80, 78, 71] },
          },
        },
        unrelatedPayload: {
          type: "record",
          source: {
            media_type: "application/json",
            data: "ordinary-checkpoint-data",
            b64_json: "ordinary-checkpoint-b64-json",
          },
        },
        unrelatedBinaryShapes: {
          data: [1, 2, 3],
          buffer: { type: "Buffer", data: [4, 5, 6] },
        },
        wrappedDataUri: "  \ndata:image/png;base64,WRAPPED-AAA\nWRAPPED-BBB",
        svgDataUri:
          'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><text>WHOLE-SVG-PAYLOAD</text></svg>',
        inlineWrappedDataUri:
          "Inline preview 'data:image/png;base64,INLINE-AAA\nINLINE-BBB' remains reviewed.",
        unquotedWrappedDataUri: "Preview data:image/png;base64,UNQUOTED-AAAA\nUNQUOTED-BBBB",
        inlineSvgDataUri:
          'SVG preview data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><text>INLINE-SVG-PAYLOAD</text></svg> remains reviewed.',
      },
    };
    const checkpointBeforeWake = structuredClone(checkpoint);

    // This proves the production checkpoint shape is sufficient to trigger the
    // embedded runner's local prompt-image detection before sanitization.
    expect(detectImageReferences(JSON.stringify(checkpoint))).not.toHaveLength(0);

    const message = buildMonitorWakeMessage({
      nowIso: "2026-07-13T01:30:00.000Z",
      wakeReason: "cron:monitor-dld",
      monitor: {
        monitorId: "monitor-dld",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-dld",
        sourceType: "telegram-user",
        sourceTarget: { chat: "6783130823" },
        cadence: { kind: "every", everyMs: 600_000 },
        actionPolicy: "notify_only",
        status: "active",
        lastCheckpoint: checkpoint,
        cronJobId: "cron-dld",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(detectImageReferences(message)).toEqual([]);
    expect(message).not.toContain("91f-proof.jpg");
    expect(message).not.toContain("file:///Users/test/Pictures/follow-up.png");
    expect(message).not.toContain("file:///Users/test/proofs/final proof.png");
    expect(message).toContain("Single proof [media reference omitted] remains reviewed.");
    expect(message).toContain("Backtick proof [media reference omitted] remains reviewed.");
    expect(message).toContain("Double proof [media reference omitted] remains reviewed.");
    expect(message).toContain("Bare tilde [media reference omitted] remains reviewed.");
    expect(message).toContain("Parenthesized ([media reference omitted]) remains reviewed.");
    expect(message).not.toContain("https://cdn.example.com/proofs/confirmation.webp");
    expect(message).not.toContain("data:image/jpeg;base64");
    expect(message).not.toContain("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB");
    expect(message).not.toContain("nested-image-base64-payload");
    expect(message).not.toContain("generated-image-b64-json-payload");
    expect(message).not.toContain("snake-case-image-base64-payload");
    expect(message).toContain(
      '"byteArrayImage":{"type":"image","mimeType":"image/png","data":"[media reference omitted]"}',
    );
    expect(message).toContain(
      '"serializedBufferImage":{"type":"image","source":{"mediaType":"image/png","data":"[media reference omitted]"}}',
    );
    expect(message).toContain("ordinary-checkpoint-data");
    expect(message).toContain("ordinary-checkpoint-b64-json");
    expect(message).toContain('"unrelatedBinaryShapes":{"data":[1,2,3]');
    expect(message).toContain('"buffer":{"type":"Buffer","data":[4,5,6]}');
    expect(message).toContain('"wrappedDataUri":"[media reference omitted]"');
    expect(message).toContain('"svgDataUri":"[media reference omitted]"');
    expect(message).toContain("Inline preview [media reference omitted] remains reviewed.");
    expect(message).toContain('"unquotedWrappedDataUri":"[media reference omitted]"');
    expect(message).toContain("SVG preview [media reference omitted] remains reviewed.");
    expect(message).not.toContain("WRAPPED-BBB");
    expect(message).not.toContain("WHOLE-SVG-PAYLOAD");
    expect(message).not.toContain("INLINE-BBB");
    expect(message).not.toContain("UNQUOTED-BBBB");
    expect(message).not.toContain("INLINE-SVG-PAYLOAD");
    expect(message).not.toContain("feedback confirmation.png");
    expect(message).not.toContain("follow up.jpeg");
    expect(message).not.toContain("final confirmation.webp");
    expect(message).not.toContain("media attachment.tiff");
    expect(message).toContain("[media reference omitted]");
    expect(message).toContain('"id":"checkpoint-dld-91f"');
    expect(message).toContain('"checkedAt":"2026-07-13T01:23:45.000Z"');
    expect(message).toContain('"chatTarget":"+971507664706"');
    expect(message).toContain('"screenshotId":"screenshot-record-17"');
    expect(message).toContain("Feedback was confirmed and the conversation remains resolved.");
    expect(checkpoint).toEqual(checkpointBeforeWake);
  });

  it("bounds pathological checkpoint structures while retaining their useful prefix", () => {
    const checkpoint: Record<string, unknown> = {
      id: "checkpoint-pathological",
      summary: "Keep this useful checkpoint prefix.",
      oversizedText: "x".repeat(100_000),
      oversizedList: Array.from({ length: 1_000 }, (_, index) => ({ index })),
    };
    // Persisted checkpoints are JSON, so cycles should not normally exist. The
    // wake renderer still must fail closed if an in-memory caller supplies one.
    checkpoint.circular = checkpoint;

    const message = buildMonitorWakeMessage({
      nowIso: "2026-07-13T01:30:00.000Z",
      wakeReason: "cron:pathological",
      monitor: {
        monitorId: "monitor-pathological",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-pathological",
        sourceType: "synthetic",
        sourceTarget: { source: "proof" },
        cadence: { kind: "every", everyMs: 600_000 },
        actionPolicy: "notify_only",
        status: "active",
        lastCheckpoint: checkpoint,
        cronJobId: "cron-pathological",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain('"id":"checkpoint-pathological"');
    expect(message).toContain("Keep this useful checkpoint prefix.");
    expect(message).toContain("omitted");
    expect(message.length).toBeLessThan(30_000);
  });

  it("tells the waking agent to treat checkpoint data as baseline instead of final authority", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      monitor: {
        monitorId: "monitor-1",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-1",
        sourceType: "gmail",
        sourceTarget: { account: "me@example.com", threadId: "thread-1" },
        cadence: { kind: "every", everyMs: 300_000 },
        stopCondition: "Stop when the thread is resolved.",
        actionPolicy: "notify_draft",
        goal: { id: "goal-1", objective: "Get the refund confirmed." },
        status: "completed",
        lastCheckpoint: {
          resolved: true,
          latestInboundText: "Thanks, we're all set.",
        },
        cronJobId: "cron-1",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain(
      "If fresh source inspection finds a new actionable change after an older resolved-looking checkpoint, keep the monitor active and continue the task.",
    );
    expect(message).toContain(
      "Do not keep or re-mark the monitor completed solely because older checkpoint data looked settled.",
    );
    expect(message).toContain("Write the update like an assistant talking to the user");
    expect(message).toContain("include the actual draft text");
    expect(message).toContain("only needs a status update");
    expect(message).toContain("goalObjective: Get the refund confirmed.");
    expect(message).toContain("Goal autonomy: observe_only.");
    expect(message).toContain("next unchanged check is 1");
    expect(message).toContain("notificationDecision.shouldNotify");
    expect(message).toContain("SLA or response deadline has passed");
    expect(message).toContain("Evaluate after this wake");
  });

  it("keeps delivery policy from escalating an observe-only bound goal", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      watchDeliveryConfigured: true,
      monitor: {
        monitorId: "monitor-observe",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-observe",
        sourceType: "whatsapp",
        sourceTarget: { target: "74333133234289@lid" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "auto_send",
        goal: { id: "goal-1", objective: "Observe the negotiation." },
        status: "active",
        cronJobId: "cron-observe",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain("Goal autonomy: observe_only.");
    expect(message).not.toContain("Watched-surface delivery is authorized");
    expect(message).toContain("Default behavior is notify + draft to the origin chat");
  });

  it("executes explicitly allowed goal actions and asks only at recorded boundaries", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      monitor: {
        monitorId: "monitor-act",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-act",
        sourceType: "synthetic",
        sourceTarget: { source: "proof" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "notify_only",
        goal: {
          id: "goal-1",
          objective: "Keep the vendor moving.",
          autonomy: {
            level: "act_within_scope",
            allowedActions: ["send follow-ups under the agreed terms"],
            approvalRequired: ["change price or scope"],
          },
        },
        status: "active",
        cronJobId: "cron-act",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain("Goal autonomy: act_within_scope.");
    expect(message).toContain("Allowed actions: send follow-ups under the agreed terms");
    expect(message).toContain("Approval required: change price or scope");
    expect(message).toContain("Use normal tools and skills to execute allowed in-scope actions");
  });

  it("keeps act-within-scope autonomy when the delivery adapter is unavailable", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      watchDeliveryConfigured: false,
      monitor: {
        monitorId: "monitor-act-no-adapter",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-act-no-adapter",
        sourceType: "custom-service",
        sourceTarget: { thread: "ticket-1" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "auto_send",
        goal: {
          id: "goal-1",
          objective: "Keep the ticket moving.",
          autonomy: {
            level: "act_within_scope",
            allowedActions: ["use the service skill to post approved follow-ups"],
            approvalRequired: ["change the requested outcome"],
          },
        },
        status: "active",
        cronJobId: "cron-act-no-adapter",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain("Only the delivery adapter is unavailable");
    expect(message).toContain("act_within_scope autonomy remains intact");
    expect(message).toContain("Use an available normal tool or skill path");
    expect(message).toContain("preserve every approval-required boundary");
  });

  it("preserves the reopened-conversation regression contract for WhatsApp-like checkpoints", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      monitor: {
        monitorId: "monitor-2",
        agentId: "main",
        originSessionKey: "agent:main:main",
        monitorSessionKey: "agent:main:monitor:monitor-2",
        sourceType: "whatsapp",
        sourceTarget: { target: "+971507664706" },
        cadence: { kind: "every", everyMs: 300_000 },
        stopCondition: "Watch for new inbound and draft the next response.",
        actionPolicy: "notify_draft",
        status: "completed",
        lastCheckpoint: {
          negotiationComplete: true,
          latestInboundText: "Ok 8pm fine wtv",
        },
        cronJobId: "cron-2",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain("Interpret lastCheckpoint as previous state, not final authority");
    expect(message).toContain(
      "If fresh source inspection finds a new actionable change after an older resolved-looking checkpoint, keep the monitor active and continue the task.",
    );
  });

  it("switches auto_send wakes into reply-only delivery guidance when watched-surface delivery is configured", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      watchDeliveryConfigured: true,
      monitor: {
        monitorId: "monitor-3",
        agentId: "main",
        originSessionKey: "agent:main:main",
        originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
        monitorSessionKey: "agent:main:monitor:monitor-3",
        sourceType: "whatsapp",
        sourceTarget: { target: "74333133234289@lid" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "auto_send",
        status: "active",
        cronJobId: "cron-3",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain(
      "Watched-surface delivery is authorized and configured for this wake.",
    );
    expect(message).toContain(
      'originDelivery: {"mode":"announce","channel":"telegram","to":"user-1"}',
    );
    expect(message).toContain(
      "For green-zone follow-ups, reply only with the exact content that should be sent to the watched surface.",
    );
    expect(message).toContain(
      "Do not add monitoring summaries, labels, explanations, markdown, or 'Suggested reply' to watched-surface replies.",
    );
    expect(message).toContain(
      "If the next step needs user input or approval, send the approval question to originDelivery with the message tool, then return exactly NO_REPLY.",
    );
    expect(message).toContain("Do not send approval questions");
    expect(message).toContain("return exactly NO_REPLY");
  });

  it("guides telegram-user auto_send wakes to use the Telegram-as-me CLI directly", () => {
    const message = buildMonitorWakeMessage({
      nowIso: "2026-04-10T04:30:13.436Z",
      wakeReason: "cron:test",
      watchDeliveryConfigured: true,
      monitor: {
        monitorId: "monitor-telegram-user",
        agentId: "main",
        originSessionKey: "agent:main:telegram:direct:user-1",
        originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
        monitorSessionKey: "agent:main:monitor:monitor-telegram-user",
        sourceType: "telegram-user",
        sourceTarget: { chat: "6783130823" },
        cadence: { kind: "every", everyMs: 300_000 },
        actionPolicy: "auto_send",
        status: "active",
        cronJobId: "cron-telegram-user",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });

    expect(message).toContain(
      "Telegram-as-me watched-surface delivery is authorized and configured for chat 6783130823.",
    );
    expect(message).toContain("use the telegram-user skill/CLI");
    expect(message).toContain("proposes something outside the user's stated constraints");
    expect(message).toContain("do not ask the user unless you are considering accepting");
    expect(message).toContain("After a successful Telegram-as-me send");
    expect(message).toContain("Do not also send the same green-zone reply to the origin chat.");
    expect(message).not.toContain(
      "auto_send was requested, but no watched-surface delivery target is configured.",
    );
  });
});
