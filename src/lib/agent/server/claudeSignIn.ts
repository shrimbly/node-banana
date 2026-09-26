/**
 * Claude Code's own sign-in flow, started from the panel. Server-only.
 *
 * We run `claude auth login --claudeai` — the official CLI, subscription
 * login only (never `--console`, which bills API credits). The CLI opens the
 * browser itself, runs its own localhost callback and stores the credentials
 * where it always does; Node Banana never sees a token.
 *
 * The URL the CLI prints ("If the browser didn't open, visit: <url>") is
 * never relayed. It is Claude's manual flow: its page shows a code to paste
 * back into the CLI (redirect_uri platform.claude.com/oauth/code/callback),
 * which this app would have to carry — putting it between the user and their
 * credential, which Anthropic doesn't allow. That line only tells us the flow
 * has started; if no browser tab opened, the user runs `claude auth login`
 * in a terminal instead.
 *
 * The child outlives the HTTP request that started it: the manager lives on
 * globalThis (so Next dev reloads don't orphan it) and kills it after ten
 * minutes.
 */

import type { Readable } from "node:stream";
import type { AgentSignInStart, AgentSignInState } from "../types";
import { CLAUDE_SIGN_IN_COMMAND } from "./claudeStatus";

/** The parts of a ChildProcess the sign-in flow uses. */
export interface SignInProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnSignIn = (
  bin: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string },
) => SignInProcess;

export interface ClaudeSignInOptions {
  spawn: SpawnSignIn;
  /** Give up on the flow (and kill the CLI) after this long. */
  timeoutMs?: number;
  /** How long start() waits for the CLI to show its flow has started (it prints its URL) before answering. */
  urlWaitMs?: number;
}

export const CLAUDE_SIGN_IN_ARGS = ["auth", "login", "--claudeai"];

/** What to do when no browser tab opened: the CLI's own flow in a terminal, never the printed URL. */
const TERMINAL_FALLBACK = `If no browser tab opened, run \`${CLAUDE_SIGN_IN_COMMAND}\` in a terminal instead.`;

const OUTPUT_TAIL = 4_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * The sign-in URL Claude Code printed ("If the browser didn't open, visit:
 * <url>"). Only read as a sign that the flow has started; never relayed.
 */
export function parseSignInUrl(output: string): string | undefined {
  const text = output.replace(ANSI, "");
  const visit = text.match(/visit:\s*(https:\/\/\S+)/i);
  if (visit) return visit[1];
  return text.match(/https:\/\/\S*(?:claude\.ai|claude\.com|anthropic\.com)\S*/i)?.[0];
}

/** Any web address: a line carrying one is never shown (it may be the manual flow's sign-in URL). */
const URL_IN_LINE = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:claude|anthropic)\.(?:ai|com)\//i;
/** The manual flow's prompt for the code its page shows ("Paste code here if prompted >"): not ours to relay. */
const PASTE_CODE_PROMPT = /\bpaste\b.*\bcode\b/i;

/**
 * Why the sign-in failed: the CLI's own failure line ("Login failed: …");
 * else, when it was killed by a signal, how it stopped (its last line then
 * is just wherever it was cut off); else the last line it printed. Never a
 * line with a URL in it: when the CLI dies right after printing "If the
 * browser didn't open, visit: <url>", that line is the manual flow's URL,
 * which is never relayed (see the module comment); nor its paste-the-code prompt.
 */
export function failureReason(output: string, exit: { signal: string | null; fallback: string }): string {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !URL_IN_LINE.test(line) && !parseSignInUrl(line) && !PASTE_CODE_PROMPT.test(line));
  const failure = lines.find((line) => /failed|error/i.test(line));
  if (failure) return failure;
  return exit.signal ? exit.fallback : (lines.at(-1) ?? exit.fallback);
}

interface SignInAttempt {
  process: SignInProcess | null;
  state: "pending" | "succeeded" | "failed";
  /** The CLI printed its sign-in URL: the flow has started (the URL itself is not kept). */
  flowStarted: boolean;
  error?: string;
  output: string;
  timer?: ReturnType<typeof setTimeout>;
  settle?: () => void;
}

export class ClaudeSignIn {
  private attempt: SignInAttempt | null = null;
  private settledCount = 0;
  private readonly timeoutMs: number;
  private readonly urlWaitMs: number;

  constructor(private readonly options: ClaudeSignInOptions) {
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.urlWaitMs = options.urlWaitMs ?? 8_000;
  }

  /** Changes whenever an attempt ends, so status caches can tell they are stale. */
  get settled(): number {
    return this.settledCount;
  }

  /** The state the panel shows. Never a URL (see the module comment). */
  state(): AgentSignInState {
    const attempt = this.attempt;
    if (!attempt || attempt.state === "succeeded") return { state: "idle" };
    if (attempt.state === "failed") return { state: "failed", error: attempt.error };
    return { state: "pending" };
  }

  /** Start the CLI's sign-in (or report the one already running). */
  async start(bin: string, env: Record<string, string>, cwd: string): Promise<AgentSignInStart> {
    const running = this.attempt;
    if (running?.state === "pending" && running.process) {
      return { state: "pending", message: `Finish signing in in your browser. ${TERMINAL_FALLBACK}` };
    }

    const attempt: SignInAttempt = { process: null, state: "pending", flowStarted: false, output: "" };
    this.attempt = attempt;

    let child: SignInProcess;
    try {
      child = this.options.spawn(bin, CLAUDE_SIGN_IN_ARGS, { env, cwd });
    } catch (error) {
      this.finish(attempt, "failed", `Couldn't start Claude Code's sign-in: ${(error as Error).message}`);
      return { state: "failed", message: attempt.error };
    }
    attempt.process = child;

    const ready = new Promise<void>((resolve) => {
      attempt.settle = resolve;
    });
    const onOutput = (chunk: Buffer | string) => {
      attempt.output = (attempt.output + chunk.toString()).slice(-OUTPUT_TAIL);
      if (!attempt.flowStarted && parseSignInUrl(attempt.output)) {
        attempt.flowStarted = true;
        attempt.settle?.();
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", (error) => {
      this.finish(attempt, "failed", `Couldn't start Claude Code's sign-in: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (attempt.state !== "pending") return;
      if (code === 0) this.finish(attempt, "succeeded");
      else {
        const fallback = signal ? `Claude Code's sign-in stopped (${signal}).` : "Claude Code's sign-in failed.";
        this.finish(attempt, "failed", failureReason(attempt.output, { signal, fallback }));
      }
    });

    attempt.timer = setTimeout(() => {
      if (attempt.state !== "pending") return;
      attempt.process?.kill("SIGTERM");
      this.finish(attempt, "failed", "Sign-in wasn't completed within 10 minutes. Start it again when you're ready.");
    }, this.timeoutMs);
    attempt.timer.unref?.();

    const waited = setTimeout(() => attempt.settle?.(), this.urlWaitMs);
    await ready;
    clearTimeout(waited);

    if (attempt.state === "succeeded") {
      return { state: "already_signed_in", message: "Claude Code is signed in." };
    }
    if (attempt.state === "failed") return { state: "failed", message: attempt.error };
    return {
      state: "pending",
      message: `${
        attempt.flowStarted
          ? "Claude Code opened its sign-in page in your browser."
          : "Claude Code is opening its sign-in page in your browser."
      } ${TERMINAL_FALLBACK}`,
    };
  }

  /** Stop a running attempt (e.g. on server shutdown). */
  cancel(): void {
    const attempt = this.attempt;
    if (attempt?.state !== "pending") return;
    attempt.process?.kill("SIGTERM");
    this.finish(attempt, "failed", "Sign-in was cancelled.");
  }

  private finish(attempt: SignInAttempt, state: "succeeded" | "failed", error?: string): void {
    if (attempt.state !== "pending") return;
    attempt.state = state;
    attempt.error = error;
    attempt.process = null;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.settle?.();
    this.settledCount += 1;
  }
}
