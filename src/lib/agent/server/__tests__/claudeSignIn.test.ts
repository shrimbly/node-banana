// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SIGN_IN_ARGS, ClaudeSignIn, failureReason, parseSignInUrl, type SignInProcess } from "../claudeSignIn";

class FakeChild extends EventEmitter implements SignInProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills: Array<NodeJS.Signals | undefined> = [];
  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    return true;
  }
}

/**
 * What Claude Code 2.1.x prints: its manual flow, whose page shows a code to
 * paste back into the CLI (redirect_uri platform.claude.com/oauth/code/callback).
 */
const URL =
  "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code" +
  "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=STATE";
const PRINTED = `Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\nPaste code here if prompted > `;

function manager(child: FakeChild, options: { timeoutMs?: number; urlWaitMs?: number } = {}) {
  const spawn = vi.fn(() => child);
  return { spawn, signIn: new ClaudeSignIn({ spawn, urlWaitMs: 50, ...options }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseSignInUrl", () => {
  it("reads the URL after 'visit:'", () => {
    expect(parseSignInUrl(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\nPaste code here if prompted > `)).toBe(URL);
  });

  it("strips ANSI and OSC-8 hyperlink wrappers", () => {
    const wrapped = `\u001b[1mvisit:\u001b[22m \u001b]8;;${URL}\u0007${URL}\u001b]8;;\u0007`;
    expect(parseSignInUrl(wrapped)).toBe(URL);
  });

  it("falls back to any Claude URL, and ignores unrelated output", () => {
    expect(parseSignInUrl(`go to ${URL} now`)).toBe(URL);
    expect(parseSignInUrl("Opening browser to sign in…")).toBeUndefined();
    expect(parseSignInUrl("visit: http://insecure.example")).toBeUndefined();
  });
});

describe("ClaudeSignIn", () => {
  it("only ever runs the subscription login", () => {
    expect(CLAUDE_SIGN_IN_ARGS).toEqual(["auth", "login", "--claudeai"]);
    expect(CLAUDE_SIGN_IN_ARGS).not.toContain("--console");
  });

  it("starts the CLI and answers once it printed its URL, without relaying that URL (review C20)", async () => {
    const child = new FakeChild();
    const { spawn, signIn } = manager(child, { urlWaitMs: 60_000 });
    const started = signIn.start("/bin/claude", { HOME: "/h" }, "/cwd");
    child.stdout.write(PRINTED);
    // Answers on the printed line, well before the wait runs out.
    const answer = await started;
    expect(answer).toEqual({
      state: "pending",
      message:
        "Claude Code opened its sign-in page in your browser. If no browser tab opened, run `claude auth login` in a terminal instead.",
    });
    expect(spawn).toHaveBeenCalledWith("/bin/claude", ["auth", "login", "--claudeai"], { env: { HOME: "/h" }, cwd: "/cwd" });
    expect(signIn.state()).toEqual({ state: "pending" });
    // The manual flow's URL (or any part of it) never leaves the server.
    expect(JSON.stringify([answer, signIn.state()])).not.toMatch(/oauth|claude\.ai|platform\.claude\.com|STATE/);
  });

  it("answers pending with the terminal fallback when the CLI is slow to print anything", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    const answer = await signIn.start("/bin/claude", {}, "/cwd");
    expect(answer).toEqual({
      state: "pending",
      message:
        "Claude Code is opening its sign-in page in your browser. If no browser tab opened, run `claude auth login` in a terminal instead.",
    });
    expect(answer).not.toHaveProperty("url");
  });

  it("reuses the running attempt instead of starting another CLI", async () => {
    const child = new FakeChild();
    const { spawn, signIn } = manager(child);
    const first = signIn.start("/bin/claude", {}, "/cwd");
    child.stdout.write(`visit: ${URL}\n`);
    await first;
    const again = await signIn.start("/bin/claude", {}, "/cwd");
    expect(again).toEqual({ state: "pending", message: expect.stringMatching(/`claude auth login` in a terminal/) });
    expect(again).not.toHaveProperty("url");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("goes idle after a successful login and marks the attempt settled", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    expect(signIn.settled).toBe(0);
    const started = signIn.start("/bin/claude", {}, "/cwd");
    child.stdout.write(`visit: ${URL}\n`);
    await started;
    child.stdout.write("Login successful.\n");
    child.emit("exit", 0, null);
    expect(signIn.state()).toEqual({ state: "idle" });
    expect(signIn.settled).toBe(1);
  });

  it("reports the CLI's failure line", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    const started = signIn.start("/bin/claude", {}, "/cwd");
    child.stdout.write(`visit: ${URL}\n`);
    await started;
    child.stderr.write("Login failed: state mismatch\n");
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 1, null);
    expect(signIn.state()).toEqual({ state: "failed", error: "Login failed: state mismatch" });
  });

  it("reports an immediate failure from start()", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    const started = signIn.start("/bin/claude", {}, "/cwd");
    child.stdout.write("Login failed: no browser\n");
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 1, null);
    await expect(started).resolves.toEqual({ state: "failed", message: "Login failed: no browser" });
  });

  it("never relays the manual-flow URL when the CLI is killed right after printing it (audit)", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    const started = signIn.start("/bin/claude", {}, "/cwd");
    child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\n`);
    const answer = await started;
    // Killed from outside: the OOM killer, `pkill claude`, an updater replacing the binary.
    child.emit("exit", null, "SIGKILL");
    const state = signIn.state();
    expect(state).toEqual({ state: "failed", error: "Claude Code's sign-in stopped (SIGKILL)." });
    for (const shown of [JSON.stringify(state), JSON.stringify(answer)]) {
      expect(shown).not.toMatch(/claude\.ai|platform\.claude\.com|https?:/);
    }
  });

  it("never relays the URL as the last line of a failed exit either", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    const started = signIn.start("/bin/claude", {}, "/cwd");
    child.stdout.write(`visit: ${URL}\n`);
    await started;
    child.emit("exit", 1, null);
    expect(signIn.state()).toEqual({ state: "failed", error: "Claude Code's sign-in failed." });
  });

  it("reports a spawn error", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    const started = signIn.start("/bin/claude", {}, "/cwd");
    child.emit("error", new Error("spawn ENOENT"));
    await expect(started).resolves.toMatchObject({ state: "failed", message: expect.stringMatching(/ENOENT/) });
  });

  it("kills the CLI after the time limit", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { signIn } = manager(child, { timeoutMs: 1_000, urlWaitMs: 10 });
    const started = signIn.start("/bin/claude", {}, "/cwd");
    await vi.advanceTimersByTimeAsync(10);
    await started;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(signIn.state()).toMatchObject({ state: "failed", error: expect.stringMatching(/10 minutes/) });
  });

  it("can be cancelled", async () => {
    const child = new FakeChild();
    const { signIn } = manager(child);
    await signIn.start("/bin/claude", {}, "/cwd");
    signIn.cancel();
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(signIn.state()).toMatchObject({ state: "failed" });
  });
});

describe("failureReason", () => {
  const exited = { signal: null, fallback: "Claude Code's sign-in failed." };
  const killed = { signal: "SIGTERM", fallback: "Claude Code's sign-in stopped (SIGTERM)." };

  it("prefers the CLI's own failure line, and never one with a URL", () => {
    expect(failureReason(`${PRINTED}\nLogin failed: state mismatch\n`, exited)).toBe("Login failed: state mismatch");
    expect(failureReason(`Error: open https://claude.ai/oauth/authorize?x=1 failed\n`, exited)).toBe(exited.fallback);
    expect(failureReason(`Error visiting claude.ai/oauth/authorize?code=true\n`, exited)).toBe(exited.fallback);
  });

  it("uses how the CLI stopped after a signal, else its last URL-free line", () => {
    expect(failureReason("Opening browser to sign in…\n", killed)).toBe(killed.fallback);
    expect(failureReason("Timed out waiting for the browser.\n", exited)).toBe("Timed out waiting for the browser.");
    // The manual flow's own lines (its URL, its paste-the-code prompt) are never the reason.
    expect(failureReason(PRINTED, exited)).toBe("Opening browser to sign in…");
    expect(failureReason("", exited)).toBe(exited.fallback);
  });
});
