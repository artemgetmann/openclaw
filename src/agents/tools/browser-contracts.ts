import type { AgentToolResult } from "@mariozechner/pi-agent-core";

type BrowserContract = {
  id: string;
  title: string;
  match: (url: URL) => boolean;
  hazards: string[];
  requiredFlow: string[];
  avoid: string[];
  proof: string[];
};

type BrowserContractResult = {
  ok: true;
  url?: string;
  intent?: string;
  contractId: string;
  contractAvailable: boolean;
  requiredNextStep?: string;
  contract: {
    title: string;
    hazards: string[];
    requiredFlow: string[];
    avoid: string[];
    proof: string[];
  };
};

const GENERIC_EXTERNAL_MUTATION_CONTRACT: Omit<BrowserContract, "match"> = {
  id: "generic-external-mutation",
  title: "Generic external mutation contract",
  hazards: [
    "browser clicks and DOM state do not prove that a third-party app accepted or committed the intended state",
    "rich editors and app-controlled forms can display text while their internal draft state differs",
    "final external mutations include posting, sending, publishing, checkout, account changes, deletes, and permission changes",
  ],
  requiredFlow: [
    "capture the pre-commit state with a fresh snapshot or screenshot",
    "use the least synthetic input path that fits the surface; prefer real keyboard paste/type for rich editors",
    "perform the external commit only after the user has approved any irreversible or public action",
    "open or inspect the committed artifact after the action completes",
    "verify the final artifact contains the expected text, media, target, and state before reporting success",
  ],
  avoid: [
    "do not treat an enabled button, closed composer, or successful click as proof",
    "do not treat visible composer/form state as final success",
    "do not use kind=fill as the final text-entry method for rich editors when the next step is a public/external commit",
    "do not retry a failed public mutation blindly; stop and report the observed final artifact",
  ],
  proof: [
    "final artifact URL or stable page state",
    "fresh snapshot or screenshot of the final artifact",
    "explicit comparison against the expected text/media/target",
  ],
};

// Keep site-specific browser guidance out of the base prompt. The model gets a
// short instruction to request a contract, then this action returns only the
// matching rules for the current site/workflow.
const SITE_CONTRACTS: BrowserContract[] = [
  {
    id: "x",
    title: "X/Twitter posting contract",
    match: (url) => /(^|\.)(?:x|twitter)\.com$/i.test(url.hostname),
    hazards: [
      "X uses rich app-controlled composers; visible text and attached media can diverge from the payload that publishes",
      "community posts add another state dimension: the selected audience must survive until commit",
      "direct community post URLs may be unavailable or transient even when the profile artifact exists",
    ],
    requiredFlow: [
      "use the signed-in or explicitly requested live profile for account-bound posting",
      "prefer keyboard paste/type over kind=fill for the final composer text when media is attached",
      "verify the composer has the exact text, intended media, selected audience/community, and enabled Post control immediately before clicking",
      "after posting, open the profile or final post artifact and verify the published artifact itself",
      "report success only after the live artifact shows the expected caption, media, and audience/community when visible",
    ],
    avoid: [
      "do not rely on composer snapshots alone",
      "do not rely on the composer closing as success",
      "do not claim success if the live artifact is image-only, text-only, wrong-audience, or inaccessible",
      "do not perform repeated public retries after one media/text mismatch without explicit user approval",
    ],
    proof: [
      "live profile or post page showing the newly published artifact",
      "exact expected caption visible in final artifact or a clear statement that it is missing",
      "media visible in final artifact",
      "community/audience label when X exposes it",
    ],
  },
  {
    id: "gmail",
    title: "Gmail send contract",
    match: (url) => /(^|\.)mail\.google\.com$/i.test(url.hostname),
    hazards: [
      "draft composer state is not delivery proof",
      "send can fail due account, quota, auth, attachment, or recipient validation errors after the click",
    ],
    requiredFlow: [
      "verify recipients, subject, body, and attachments immediately before Send",
      "use explicit user approval before sending to external recipients",
      "after Send, verify the send result through a sent-message artifact, visible confirmation, or provider response",
    ],
    avoid: [
      "do not report sent based only on a closed compose window",
      "do not retry sends after ambiguous failure without duplicate-delivery analysis",
    ],
    proof: [
      "sent message artifact, provider result, or visible sent confirmation",
      "message id when available",
      "clear duplicate-risk status if confirmation is ambiguous",
    ],
  },
  {
    id: "linkedin",
    title: "LinkedIn posting contract",
    match: (url) => /(^|\.)linkedin\.com$/i.test(url.hostname),
    hazards: [
      "LinkedIn composers and modals are app-controlled and can change selected target, media, or body before publish",
      "published artifact visibility can differ between feed, profile, company page, and group surfaces",
    ],
    requiredFlow: [
      "verify text, media, and posting destination immediately before publishing",
      "open the final post/profile/company artifact after publish",
      "verify the final artifact itself before reporting success",
    ],
    avoid: [
      "do not treat a dismissed modal as proof",
      "do not rely on composer state alone for public posts",
    ],
    proof: [
      "final published artifact on the intended LinkedIn surface",
      "expected text/media visible in that artifact",
    ],
  },
];

function parseContractUrl(rawUrl?: string): URL | null {
  if (!rawUrl?.trim()) {
    return null;
  }
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function resolveBrowserContract(rawUrl?: string): BrowserContract | null {
  const parsedUrl = parseContractUrl(rawUrl);
  if (!parsedUrl) {
    return null;
  }
  return SITE_CONTRACTS.find((contract) => contract.match(parsedUrl)) ?? null;
}

function contractToResult(params: {
  rawUrl?: string;
  intent?: string;
  contract: Omit<BrowserContract, "match">;
  contractAvailable: boolean;
}): BrowserContractResult {
  return {
    ok: true,
    ...(params.rawUrl ? { url: params.rawUrl } : {}),
    ...(params.intent ? { intent: params.intent } : {}),
    contractId: params.contract.id,
    contractAvailable: params.contractAvailable,
    requiredNextStep:
      "follow this contract before the external commit, then verify the final artifact",
    contract: {
      title: params.contract.title,
      hazards: params.contract.hazards,
      requiredFlow: params.contract.requiredFlow,
      avoid: params.contract.avoid,
      proof: params.contract.proof,
    },
  };
}

export function executeBrowserContractAction(params: {
  url?: string;
  intent?: string;
}): AgentToolResult<BrowserContractResult> {
  const siteContract = resolveBrowserContract(params.url);
  const contract = siteContract ?? GENERIC_EXTERNAL_MUTATION_CONTRACT;
  const result = contractToResult({
    rawUrl: params.url,
    intent: params.intent,
    contract,
    contractAvailable: Boolean(siteContract),
  });
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

export const __testing = {
  resolveBrowserContract,
};
