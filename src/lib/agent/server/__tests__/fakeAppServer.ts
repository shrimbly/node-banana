/**
 * A scripted stand-in for the `codex app-server` child process: reads the
 * client's JSON-RPC lines from stdin and answers from per-method handlers.
 * Test helper only (not a test file).
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import type { AppServerProcess } from "../codexAppServer";

export interface RpcLine {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export type FakeHandler = (params: any, server: FakeAppServer) => unknown;

export const DEFAULT_HANDLERS: Record<string, FakeHandler> = {
  initialize: () => ({
    userAgent: "node_banana/0.157.0 (Mac OS 26.6.0; arm64) unknown (node_banana; 1.10.0)",
    codexHome: "/Users/user/.codex",
    platformFamily: "unix",
    platformOs: "macos",
  }),
  "config/read": () => ({ config: { mcp_servers: { node_repl: {}, "computer-use": {} }, model_provider: null } }),
  "account/read": () => ({
    account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
    requiresOpenaiAuth: true,
  }),
  // Recorded shape (Pro plan, plenty left, no purchased credits).
  "account/rateLimits/read": () => ({
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1790368200 },
      secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1790647200 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null,
      spendControlReached: false,
      planType: "pro",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  }),
  "thread/unsubscribe": () => ({ status: "unsubscribed" }),
  "model/list": () => ({
    data: [
      { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false, isDefault: true },
      { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", hidden: false, isDefault: false },
      { id: "secret", model: "secret", displayName: "Hidden", hidden: true, isDefault: false },
    ],
    nextCursor: null,
  }),
};

export class FakeAppServer extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every line the client wrote. */
  readonly received: RpcLine[] = [];
  readonly handlers: Record<string, FakeHandler>;
  private nextId = 1_000;
  private readonly waiting = new Map<number | string, (line: RpcLine) => void>();
  exited = false;

  constructor(handlers: Record<string, FakeHandler> = {}) {
    super();
    this.handlers = { ...DEFAULT_HANDLERS, ...handlers };
    readline.createInterface({ input: this.stdin }).on("line", (line) => void this.onLine(line));
  }

  /** Requests the client sent for a method. */
  requests(method: string): RpcLine[] {
    return this.received.filter((line) => line.method === method && line.id !== undefined);
  }

  notify(method: string, params?: unknown): void {
    this.stdout.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  /** A server→client request; resolves with the client's whole answer line. */
  request(method: string, params: unknown): Promise<RpcLine> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.exit(null, signal);
    return true;
  }

  private async onLine(raw: string): Promise<void> {
    const line = JSON.parse(raw) as RpcLine;
    this.received.push(line);
    if (line.id !== undefined && !line.method) {
      this.waiting.get(line.id)?.(line);
      this.waiting.delete(line.id);
      return;
    }
    if (line.id === undefined || !line.method) return;
    const handler = this.handlers[line.method];
    if (!handler) {
      this.stdout.write(`${JSON.stringify({ id: line.id, error: { code: -32601, message: `no handler for ${line.method}` } })}\n`);
      return;
    }
    try {
      const result = await handler(line.params, this);
      if (!this.exited) this.stdout.write(`${JSON.stringify({ id: line.id, result })}\n`);
    } catch (error) {
      this.stdout.write(`${JSON.stringify({ id: line.id, error: { code: -32600, message: (error as Error).message } })}\n`);
    }
  }
}

/**
 * The thread notifications of one live turn (codex 0.157.0, gpt-5.6-luna,
 * effort low, one dynamic tool call `add_numbers {a:2,b:3}`), recorded
 * through the harness by .scratch/agent/harness/live.ts. Emails redacted.
 */
export const RECORDED_THREAD = "01a0d9b3-5b28-7ed1-a978-8c9292102095";
export const RECORDED_TURN = "01a0d9b3-5b68-75a0-a565-db58898287e0";

export function loadRecordedCodexTurn(): Array<{ method: string; params: Record<string, unknown> }> {
  return readFileSync(path.join(__dirname, "fixtures", "codex-turn.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}
