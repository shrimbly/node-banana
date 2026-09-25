import { describe, it, expect } from "vitest";
import { AGENT_HARNESS_IDS, type AgentHarnessStatus } from "../../types";
import {
  deriveAgentReadiness,
  HARNESS_BILLING_COPY,
  isHarnessReady,
  readinessTone,
  shouldPollReadiness,
  type AgentReadiness,
} from "../readiness";

function status(overrides: Partial<AgentHarnessStatus> = {}): AgentHarnessStatus {
  return {
    id: "claude",
    label: "Claude Code",
    installed: true,
    signedIn: false,
    billing: "none",
    models: [],
    signIn: { state: "idle" },
    signInCommand: "claude auth login",
    ...overrides,
  };
}

const ready = () => status({ signedIn: true, billing: "subscription", account: { plan: "max" } });

describe("deriveAgentReadiness", () => {
  it("is loading before the first answer, unavailable when the route failed", () => {
    expect(deriveAgentReadiness({})).toEqual({ kind: "loading" });
    expect(deriveAgentReadiness({ fetchError: "Couldn't check the agent status: 500" })).toEqual({
      kind: "unavailable",
      message: "Couldn't check the agent status: 500",
    });
  });

  it("keeps a known status when a later check fails", () => {
    expect(deriveAgentReadiness({ status: ready(), fetchError: "offline" }).kind).toBe("ready");
  });

  it("reports a missing CLI before anything else", () => {
    const s = status({ installed: false, signedIn: true, billing: "subscription" });
    expect(deriveAgentReadiness({ status: s }).kind).toBe("not_installed");
  });

  it("is ready only on a subscription", () => {
    expect(deriveAgentReadiness({ status: ready() }).kind).toBe("ready");
    expect(isHarnessReady(ready())).toBe(true);
  });

  it("refuses a signed-in API login as one that would bill API credits", () => {
    const s = status({ signedIn: true, billing: "api", problem: "An API key from /login would be billed." });
    expect(deriveAgentReadiness({ status: s })).toEqual({ kind: "wrong_billing", status: s });
    expect(isHarnessReady(s)).toBe(false);
  });

  // A claude.ai login without a readable plan never bills API credits: it must not be called one.
  it.each(["unknown", "none"] as const)("refuses a signed-in %s billing as an unconfirmed subscription", (billing) => {
    const s = status({ signedIn: true, billing, problem: "No Claude Pro or Max plan was found on the account." });
    expect(deriveAgentReadiness({ status: s })).toEqual({ kind: "unconfirmed_billing", status: s });
    expect(isHarnessReady(s)).toBe(false);
  });

  it("is signed out by default", () => {
    expect(deriveAgentReadiness({ status: status() }).kind).toBe("signed_out");
  });

  it("follows the server's pending sign-in, with its url and device code", () => {
    const s = status({ signIn: { state: "pending", url: "https://auth.example/device", userCode: "ABCD-1234" } });
    expect(deriveAgentReadiness({ status: s })).toEqual({
      kind: "signing_in",
      status: s,
      url: "https://auth.example/device",
      userCode: "ABCD-1234",
    });
  });

  it("fills a pending flow's url from the panel's own sign-in response", () => {
    const s = status({ signIn: { state: "pending" } });
    const result = deriveAgentReadiness({
      status: s,
      statusCheckedAt: 2000,
      signIn: { state: "pending", url: "https://claude.ai/oauth", startedAt: 1000 },
    });
    expect(result).toMatchObject({ kind: "signing_in", url: "https://claude.ai/oauth" });
  });

  it("reports a failed flow from the server", () => {
    const s = status({ signIn: { state: "failed", error: "Login timed out" } });
    expect(deriveAgentReadiness({ status: s })).toEqual({
      kind: "sign_in_failed",
      status: s,
      message: "Login timed out",
    });
  });

  describe("the panel's own sign-in attempt", () => {
    const attempt = { state: "pending" as const, url: "https://x.example", startedAt: 5000 };

    it("shows as pending until the server has been asked again", () => {
      expect(deriveAgentReadiness({ status: status(), statusCheckedAt: 4000, signIn: attempt })).toMatchObject({
        kind: "signing_in",
        url: "https://x.example",
      });
      expect(deriveAgentReadiness({ status: status(), signIn: attempt }).kind).toBe("signing_in");
    });

    it("gives way to a newer server answer (a flow that ended must not wait forever)", () => {
      expect(deriveAgentReadiness({ status: status(), statusCheckedAt: 6000, signIn: attempt }).kind).toBe(
        "signed_out",
      );
    });

    it("shows a start failure until the next check", () => {
      const failed = { state: "failed" as const, message: "claude exited with code 1", startedAt: 5000 };
      expect(deriveAgentReadiness({ status: status(), statusCheckedAt: 4000, signIn: failed })).toMatchObject({
        kind: "sign_in_failed",
        message: "claude exited with code 1",
      });
      expect(deriveAgentReadiness({ status: status(), statusCheckedAt: 6000, signIn: failed }).kind).toBe(
        "signed_out",
      );
    });

    it("never overrides a signed-in status", () => {
      expect(deriveAgentReadiness({ status: ready(), statusCheckedAt: 1, signIn: attempt }).kind).toBe("ready");
    });
  });

  // Signing in is how a user replaces a login that can't run: that flow must show and be polled.
  describe("a sign-in replacing a login that can't run", () => {
    const apiLogin = (signIn: AgentHarnessStatus["signIn"] = { state: "idle" }) =>
      status({ id: "codex", signedIn: true, billing: "api", problem: "Codex is signed in with an API key.", signIn });

    it("shows the server's pending flow with its device code, and polls", () => {
      const s = apiLogin({ state: "pending", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
      const result = deriveAgentReadiness({ status: s, statusCheckedAt: 2000 });
      expect(result).toEqual({
        kind: "signing_in",
        status: s,
        url: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      });
      expect(shouldPollReadiness(result)).toBe(true);
    });

    it("stays on the billing card while no flow runs", () => {
      expect(deriveAgentReadiness({ status: apiLogin() }).kind).toBe("wrong_billing");
    });

    it("shows the panel's own pending attempt until the server is asked again", () => {
      const attempt = { state: "pending" as const, url: "https://auth.openai.com/log-in", startedAt: 5000 };
      expect(deriveAgentReadiness({ status: apiLogin(), statusCheckedAt: 4000, signIn: attempt })).toMatchObject({
        kind: "signing_in",
        url: "https://auth.openai.com/log-in",
      });
      expect(deriveAgentReadiness({ status: apiLogin(), statusCheckedAt: 6000, signIn: attempt }).kind).toBe(
        "wrong_billing",
      );
    });

    it("carries a failed flow's error on the billing card instead of replacing it", () => {
      const s = apiLogin({ state: "failed", error: "Sign-in wasn't completed within 10 minutes" });
      expect(deriveAgentReadiness({ status: s })).toEqual({
        kind: "wrong_billing",
        status: s,
        signInError: "Sign-in wasn't completed within 10 minutes",
      });
      const failedStart = { state: "failed" as const, message: "Couldn't start sign-in: 500", startedAt: 5000 };
      expect(deriveAgentReadiness({ status: apiLogin(), statusCheckedAt: 4000, signIn: failedStart })).toMatchObject({
        kind: "wrong_billing",
        signInError: "Couldn't start sign-in: 500",
      });
    });

    it("also covers a login whose subscription can't be confirmed", () => {
      const s = status({ signedIn: true, billing: "unknown", signIn: { state: "pending" } });
      expect(deriveAgentReadiness({ status: s }).kind).toBe("signing_in");
    });

    it("is ready once the new login is on the subscription, whatever the stale attempt says", () => {
      const attempt = { state: "pending" as const, startedAt: 5000 };
      expect(deriveAgentReadiness({ status: ready(), statusCheckedAt: 4000, signIn: attempt }).kind).toBe("ready");
    });
  });
});

describe("billing copy", () => {
  // The app enforces "never an API key" and, in the harnesses, stops at the plan's
  // included usage rather than run on Claude extra usage or Codex credits. It can't
  // promise a turn costs nothing: it counts toward the plan's limits. Keep the copy
  // from promising that, and from saying turns spill over into extra usage or credits.
  it.each(AGENT_HARNESS_IDS)("%s copy never promises the turn costs nothing extra", (harness) => {
    const { runsOn, footer } = HARNESS_BILLING_COPY[harness];
    for (const line of [runsOn, footer]) {
      expect(line).not.toMatch(/no (api )?credits|free|no (extra )?cost|won't cost/i);
      expect(line).toMatch(/limit/i);
      expect(line).toMatch(/never an API key/);
      expect(line).toMatch(/stops/i);
      expect(line).not.toMatch(/toward extra usage|extra usage, if|use credits if|credits, if any/i);
    }
  });
});

describe("readiness helpers", () => {
  const s = status();
  const cases: Array<[AgentReadiness, ReturnType<typeof readinessTone>, boolean]> = [
    [{ kind: "loading" }, "unknown", false],
    [{ kind: "unavailable", message: "x" }, "unknown", false],
    [{ kind: "ready", status: s }, "ready", false],
    [{ kind: "signed_out", status: s }, "attention", false],
    [{ kind: "signing_in", status: s }, "attention", true],
    [{ kind: "sign_in_failed", status: s, message: "x" }, "attention", false],
    [{ kind: "wrong_billing", status: s }, "blocked", false],
    [{ kind: "unconfirmed_billing", status: s }, "blocked", false],
    [{ kind: "not_installed", status: s }, "blocked", false],
  ];

  it.each(cases)("%o → tone %s, poll %s", (readiness, tone, poll) => {
    expect(readinessTone(readiness)).toBe(tone);
    expect(shouldPollReadiness(readiness)).toBe(poll);
  });
});
