import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexNotification = {
  method: string;
  params?: JsonObject;
};

export type CodexServerRequest = {
  method: string;
  params?: JsonObject;
};

export type CodexServerRequestHandler = (request: CodexServerRequest) => unknown;

export type CodexRpcClient = {
  initialize(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  onNotification(handler: (notification: CodexNotification) => void): () => void;
  onServerRequest(handler: CodexServerRequestHandler): () => void;
  getServerVersion(): string | undefined;
  isClosed(): boolean;
  close(): Promise<void>;
};

export type CodexAppServerClientOptions = {
  command: string;
  args: string[];
  cwd?: string;
  requestTimeoutMs: number;
};

export class CodexRpcResponseError extends Error {
  readonly method: string;

  constructor(method: string, message: string) {
    super(`Codex App Server ${method} failed: ${message}`);
    this.name = "CodexRpcResponseError";
    this.method = method;
  }
}

/**
 * Small App Server JSON-RPC client for the compatibility pilot.
 *
 * The upstream client has managed binaries, alternate transports, auth bridges,
 * and richer server-request routing. This port intentionally keeps only the
 * same-Mac stdio contract needed by the isolated pilot. Every server approval
 * request is declined because this layer cannot safely project native Codex
 * approval UX yet.
 */
export class CodexAppServerClient implements CodexRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exitPromise: Promise<void>;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: CodexNotification) => void>();
  private readonly serverRequestHandlers = new Set<CodexServerRequestHandler>();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private closeError: Error | undefined;
  private serverVersion: string | undefined;
  private stderrTail = "";

  constructor(options: CodexAppServerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      // Keep only a bounded diagnostic tail so an unavailable binary produces
      // a useful explicit error without allowing unbounded stderr growth.
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000);
    });
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.once("exit", (code, signal) => {
      this.closeWithError(
        new Error(
          `Codex App Server exited (${code ?? signal ?? "unknown"})${
            this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""
          }`,
        ),
      );
    });
    this.child.stdin.on("error", (error) => this.closeWithError(error));
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const response = await this.request<{
      serverInfo?: { version?: string };
      protocolVersion?: string;
    }>("initialize", {
      clientInfo: {
        name: "openclaw",
        title: "OpenClaw Codex Pilot",
        version: "2026.3.14",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.serverVersion = response.serverInfo?.version ?? response.protocolVersion;
    this.notify("initialized");
    this.initialized = true;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error("Codex App Server connection is unavailable"),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  onNotification(handler: (notification: CodexNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  getServerVersion(): string | undefined {
    return this.serverVersion;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.closeError ??= new Error("Codex App Server connection was closed");
      this.lines.close();
      this.rejectPending(this.closeError);
      this.child.stdin.end();
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGTERM");
      }
    }

    // A plugin stop must not leave an App Server child behind. Give graceful
    // termination a short window, then kill only the child this client owns.
    if (!(await this.waitForExit(2_000))) {
      this.child.kill("SIGKILL");
      await this.waitForExit(1_000);
    }
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      // App Server reserves stdout for JSON-RPC. A malformed line means the
      // transport is no longer trustworthy, so fail every pending request.
      this.closeWithError(new Error("Codex App Server returned malformed JSON-RPC"));
      return;
    }
    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      this.handleResponse(message);
      return;
    }
    if (typeof message.method !== "string") {
      return;
    }
    if ("id" in message) {
      void this.handleServerRequest(message);
      return;
    }
    const notification: CodexNotification = {
      method: message.method,
      ...(isRecord(message.params) ? { params: message.params } : {}),
    };
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }

  private handleResponse(message: JsonObject): void {
    const id = typeof message.id === "number" ? message.id : Number.NaN;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      pending.reject(
        new CodexRpcResponseError(
          pending.method,
          typeof message.error.message === "string" ? message.error.message : "unknown error",
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonObject): Promise<void> {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : "";
    if (method.includes("requestApproval")) {
      // Starting a Codex turn without a projected approval bridge must never
      // turn an unavailable approval into implicit authorization.
      this.write({
        id,
        result: {
          decision: "decline",
          reason: "The OpenClaw Codex pilot does not project native approvals yet.",
        },
      });
      return;
    }
    const request: CodexServerRequest = {
      method,
      ...(isRecord(message.params) ? { params: message.params } : {}),
    };
    for (const handler of this.serverRequestHandlers) {
      try {
        const result = await handler(request);
        if (result !== undefined) {
          this.write({ id, result });
          return;
        }
      } catch (error) {
        this.write({
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
    }
    this.write({
      id,
      error: {
        code: -32601,
        message: `Unsupported App Server request: ${method || "unknown"}`,
      },
    });
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private write(message: JsonObject): void {
    if (this.closed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private closeWithError(error: Error): void {
    if (this.closed && this.closeError) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    this.lines.close();
    this.rejectPending(error);
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
