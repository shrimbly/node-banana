/**
 * A client for `codex app-server`: JSON-RPC 2.0 over stdio, one message per
 * line (the server omits the `jsonrpc` field). Server-only.
 *
 * One long-lived child per server process, shared through globalThis so Next
 * dev reloads don't spawn duplicates; it restarts on the next request after
 * it exits. The child is locked down with `-c` overrides: no shell, no file
 * edits, no web, no plugins/apps/skills/memories/hooks, no sub-agents, no
 * notify hook, the built-in OpenAI provider (so the ChatGPT login is what
 * pays), and a minimal base prompt. The user's own MCP servers are disabled
 * per thread, because config overrides can't remove them: the harness
 * re-reads the list from config.toml before every `thread/start` (see
 * `refreshUserMcpServers`), since the user can add a server while the
 * app-server runs.
 *
 * The server sends requests too (`item/tool/call`, approvals, elicitation,
 * ...). Anything without a registered handler is refused with a JSON-RPC
 * error, so an approval can never be granted by default.
 */

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { NODE_BANANA_VERSION } from "./env";

/** `-c key=value` overrides applied to the app-server process. */
export const CODEX_LOCKDOWN_CONFIG: readonly string[] = [
  ...[
    "shell_tool",
    "unified_exec",
    "multi_agent",
    "plugins",
    "apps",
    "memories",
    "hooks",
    "goals",
    "browser_use",
    "computer_use",
    "image_generation",
    "skill_search",
    "tool_suggest",
    "remote_plugin",
    "view_image",
  ].map((feature) => `features.${feature}=false`),
  'web_search="disabled"',
  // The project's AGENTS.md, the skills catalog and the coding-agent
  // instruction blocks are not for a canvas agent. (This covers project docs
  // only: the global $CODEX_HOME/AGENTS.md is always sent, and the harness
  // counters it with developer instructions — see codexHarness.ts.)
  "project_doc_max_bytes=0",
  "skills.include_instructions=false",
  "include_permissions_instructions=false",
  "include_collaboration_mode_instructions=false",
  "include_environment_context=false",
  "include_apps_instructions=false",
  "tools.experimental_request_user_input.enabled=false",
  // The user's notify hook is for their own Codex sessions.
  "notify=[]",
  // Always the built-in OpenAI provider: with a ChatGPT login that is the plan.
  // (A custom provider from config.toml could bill some other account.)
  'model_provider="openai"',
  "check_for_update_on_startup=false",
  // Threads the harness lets go of (thread/unsubscribe) are unloaded after a
  // minute instead of staying in memory until the app-server restarts.
  "thread_unload_delay_secs=60",
];

export function codexAppServerArgs(): string[] {
  return ["app-server", ...CODEX_LOCKDOWN_CONFIG.flatMap((override) => ["-c", override])];
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, error: JsonRpcErrorBody) {
    super(`${method}: ${error.message}`);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export interface CodexNotification {
  method: string;
  params?: unknown;
}

/** The parts of a ChildProcess the client uses. */
export interface AppServerProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnAppServer = (bin: string, args: string[], options: { env: Record<string, string> }) => AppServerProcess;

export interface CodexAppServerOptions {
  bin: string;
  env: Record<string, string>;
  spawn?: SpawnAppServer;
  /** Arguments after the binary; defaults to `app-server` plus the lockdown overrides. */
  args?: string[];
  requestTimeoutMs?: number;
  /** Where threads run (read-only sandbox, nothing in it). Defaults to a fresh temp dir. */
  makeWorkDir?: () => Promise<string>;
}

export interface CodexServerInfo {
  userAgent: string;
  /** Codex's version, from the user agent. */
  version?: string;
  codexHome?: string;
}

type ServerRequestHandler = (params: unknown) => Promise<unknown>;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

const defaultSpawn: SpawnAppServer = (bin, args, options) =>
  spawn(bin, args, {
    env: options.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

/** "node_banana/0.157.0 (Mac OS 26.6.0; arm64) …" → "0.157.0". */
export function parseCodexVersion(userAgent: string): string | undefined {
  return userAgent.match(/^[^/\s]+\/(\d+\.\d+\.\d+[\w.-]*)/)?.[1];
}

export class CodexAppServer {
  readonly bin: string;
  /** Incremented on every (re)start; threads from an earlier generation are gone. */
  generation = 0;
  info: CodexServerInfo | null = null;
  /** MCP servers in the user's config.toml as last read, disabled on every thread we start. */
  userMcpServers: string[] = [];
  /** `model_provider` after our overrides (null = the built-in default). */
  modelProvider: string | null = null;
  /** The (empty) directory threads run in. */
  workDir: string | null = null;

  private readonly options: CodexAppServerOptions;
  private child: AppServerProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly exitListeners = new Set<(reason: string) => void>();
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();
  private stderrTail = "";

  constructor(options: CodexAppServerOptions) {
    this.options = options;
    this.bin = options.bin;
  }

  get running(): boolean {
    return this.child !== null && this.starting === null;
  }

  /** Start (or restart) the child and initialize it. Concurrent callers share one start. */
  start(): Promise<void> {
    if (this.child && !this.starting) return Promise.resolve();
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    const spawnChild = this.options.spawn ?? defaultSpawn;
    let child: AppServerProcess;
    try {
      child = spawnChild(this.bin, this.options.args ?? codexAppServerArgs(), { env: this.options.env });
    } catch (error) {
      throw new Error(`Codex couldn't be started: ${(error as Error).message}`);
    }
    this.child = child;
    this.generation += 1;
    this.stderrTail = "";

    const lines = readline.createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.onLine(line));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2_000);
    });
    child.stdin?.on("error", () => {
      // EPIPE after the child died; the exit handler reports it.
    });
    child.on("error", (error) => this.handleExit(child, `Codex couldn't be started: ${error.message}`));
    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.trim().split("\n").at(-1);
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.handleExit(child, `Codex app-server exited (${how})${detail ? `: ${detail}` : ""}`);
    });

    try {
      const init = (await this.requestOn(child, "initialize", {
        clientInfo: { name: "node_banana", title: "Node Banana", version: NODE_BANANA_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })) as { userAgent?: string; codexHome?: string };
      this.info = {
        userAgent: init.userAgent ?? "",
        version: parseCodexVersion(init.userAgent ?? ""),
        codexHome: init.codexHome,
      };
      this.write(child, { method: "initialized" });

      const read = (await this.requestOn(child, "config/read", {})) as {
        config?: { mcp_servers?: Record<string, unknown> | null; model_provider?: string | null };
      };
      this.userMcpServers = Object.keys(read.config?.mcp_servers ?? {});
      this.modelProvider = read.config?.model_provider ?? null;
      this.workDir ??= await (this.options.makeWorkDir ?? (() => mkdtemp(path.join(os.tmpdir(), "node-banana-codex-"))))();
    } catch (error) {
      child.kill("SIGTERM");
      this.handleExit(child, (error as Error).message);
      throw error;
    }
  }

  /** Send a request and wait for its result. Starts the server when needed. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error("Codex app-server is not running.");
    return (await this.requestOn(child, method, params, timeoutMs)) as T;
  }

  /**
   * Send a request only to the child that is running now — and, with
   * `generation`, only if it is still that generation. Never starts or
   * restarts the server (an interrupt for a thread that died with its
   * app-server must not spawn a new one). Resolves undefined when skipped.
   */
  async requestIfRunning<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    generation?: number,
  ): Promise<T | undefined> {
    const child = this.child;
    if (!child || this.starting || (generation !== undefined && generation !== this.generation)) return undefined;
    return (await this.requestOn(child, method, params, timeoutMs)) as T;
  }

  /**
   * Re-read config.toml's MCP servers (config/read reads the file each time)
   * for the next thread to disable. Exactly the current list: disabling a
   * server that is no longer in the file fails `thread/start` ("invalid
   * transport"). Throws when the config can't be read, so a thread is never
   * started on a stale list.
   */
  async refreshUserMcpServers(): Promise<string[]> {
    const read = await this.request<{ config?: { mcp_servers?: Record<string, unknown> | null } }>("config/read", {}, 20_000);
    this.userMcpServers = Object.keys(read?.config?.mcp_servers ?? {});
    return this.userMcpServers;
  }

  private requestOn(child: AppServerProcess, method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { method, resolve, reject };
      const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex didn't answer ${method} within ${Math.round(limit / 1000)}s.`));
      }, limit);
      entry.timer.unref?.();
      this.pending.set(id, entry);
      if (!this.write(child, params === undefined ? { id, method } : { id, method, params })) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(new Error(`Codex app-server is not accepting requests (${method}).`));
      }
    });
  }

  /** Send a notification (no answer expected). */
  notify(method: string, params?: unknown): void {
    if (this.child) this.write(this.child, params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Called when the child exits or fails to start, with a reason for the user. */
  onExit(listener: (reason: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private handleExit(child: AppServerProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
    for (const listener of this.exitListeners) listener(reason);
  }

  /** Answer a server→client request method. Unhandled methods are refused. */
  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    this.handleExit(child, "Codex app-server was stopped.");
  }

  private write(child: AppServerProcess, message: object): boolean {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(trimmed) as RpcMessage;
    } catch {
      this.stderrTail = `${this.stderrTail}\n${trimmed}`.slice(-2_000);
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CodexRpcError(entry.method, message.error));
      else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.answerServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      const notification: CodexNotification = { method: message.method, params: message.params };
      for (const listener of this.notificationListeners) {
        try {
          listener(notification);
        } catch {
          // A listener's failure must not break the stream for the others.
        }
      }
    }
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const child = this.child;
    if (!child) return;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write(child, { id, error: { code: -32601, message: `Node Banana doesn't support "${method}".` } });
      return;
    }
    try {
      const result = await handler(params);
      this.write(child, { id, result });
    } catch (error) {
      this.write(child, { id, error: { code: -32603, message: (error as Error).message } });
    }
  }
}

/* ── the shared instance ───────────────────────────────────────── */

const globalState = globalThis as typeof globalThis & { __nodeBananaCodexAppServer?: CodexAppServer };

/**
 * The process-wide app-server for this binary. A different binary (e.g.
 * NB_CODEX_BIN changed) replaces it.
 */
export function getCodexAppServer(bin: string, env: Record<string, string>): CodexAppServer {
  const current = globalState.__nodeBananaCodexAppServer;
  if (current && current.bin === bin) return current;
  current?.stop();
  const server = new CodexAppServer({ bin, env });
  globalState.__nodeBananaCodexAppServer = server;
  return server;
}
