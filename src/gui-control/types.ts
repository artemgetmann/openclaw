export type GuiRuntimeName = "agent-desktop" | "open-computer-use";

export type GuiActionType =
  | "observe"
  | "setValue"
  | "click"
  | "secondaryAction"
  | "press"
  | "scroll";

export type GuiMutationRisk = "read-only" | "allowed-mutation" | "blocked";

export type AppTarget = {
  appName: string;
  windowTitle?: string;
  windowId?: string;
};

export type AppState = {
  appName: string;
  pid?: number;
  frontmost?: boolean;
  windows?: WindowState[];
};

export type WindowState = {
  id?: string;
  appName: string;
  pid?: number;
  title?: string;
  focused?: boolean;
};

export type ElementRef = {
  ref: string;
  snapshotId?: string;
  role?: string;
  name?: string;
  title?: string;
  label?: string;
  description?: string;
  value?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  secondaryActions?: string[];
  appName?: string;
  windowTitle?: string;
};

export type GuiSnapshot = {
  id: string;
  appName: string;
  windowId?: string;
  windowTitle?: string;
  summary?: string;
  visibleText?: string[];
  raw?: unknown;
  elements: ElementRef[];
};

export type ActionResult = {
  ok: boolean;
  actionCount?: number;
  staleRef?: boolean;
  usedClipboard?: boolean;
  rawCoordinatesUsed?: boolean;
  movedFocus?: boolean;
  message?: string;
  raw?: unknown;
};

export type VirtualPointerEvidence = {
  present: boolean;
  source: string;
  evidencePath?: string;
  phase?: string;
  notes: string;
  raw?: unknown;
};

export interface GuiRuntime {
  readonly name: GuiRuntimeName;
  listApps(): Promise<AppState[]>;
  observe(target: AppTarget): Promise<GuiSnapshot>;
  setValue(target: ElementRef, value: string): Promise<ActionResult>;
  click(target: ElementRef): Promise<ActionResult>;
  performSecondaryAction?(target: ElementRef, action: string): Promise<ActionResult>;
  press?(target: AppTarget, keys: string[]): Promise<ActionResult>;
  scroll?(
    target: ElementRef,
    options?: { direction?: "up" | "down" | "left" | "right"; amount?: number },
  ): Promise<ActionResult>;
  listWindows?(): Promise<WindowState[]>;
  focusWindow?(target: WindowState): Promise<ActionResult>;
  openUrl?(target: AppTarget, url: string): Promise<ActionResult>;
  readClipboard?(): Promise<{ ok: boolean; text?: string; raw?: unknown }>;
  writeClipboard?(text: string): Promise<ActionResult>;
  getVirtualPointerEvidence?(): Promise<VirtualPointerEvidence>;
}

export type GuiAuditRecord = {
  id: string;
  timestamp: string;
  appName: string;
  windowTitle?: string;
  elementRef?: string;
  actionType: GuiActionType;
  reason: string;
  risk: GuiMutationRisk;
  preStateSummary?: string;
  postStateVerification?: string;
  result: "verified" | "blocked" | "failed";
  failureReason?: string;
};

export type GuiVerifierStats = {
  actionCount: number;
  retries: number;
  staleRefs: number;
  usedClipboard: boolean;
  movedFocus: boolean;
  falseSuccesses: number;
  falseFailures: number;
  postStateResult?: "verified" | "failed" | "blocked";
};

export type VerifiedActionResult = {
  ok: boolean;
  audit: GuiAuditRecord;
  snapshot?: GuiSnapshot;
  stats: GuiVerifierStats;
  failureReason?: string;
};

export type VerificationResult = {
  ok: boolean;
  summary: string;
};
