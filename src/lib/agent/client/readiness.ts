/**
 * What the agent panel should show for one harness, derived from the status
 * route and any sign-in the panel started. Pure so every state is testable.
 */

import type { AgentHarnessId, AgentHarnessStatus, AgentSignInStart } from "../types";

export type AgentReadiness =
  /** First status check still running. */
  | { kind: "loading" }
  /** The status route itself failed. */
  | { kind: "unavailable"; message: string }
  | { kind: "not_installed"; status: AgentHarnessStatus }
  | { kind: "signed_out"; status: AgentHarnessStatus }
  /** A vendor sign-in is running: a first login, or one replacing a login that can't run. */
  | { kind: "signing_in"; status: AgentHarnessStatus; url?: string; userCode?: string }
  | { kind: "sign_in_failed"; status: AgentHarnessStatus; message: string }
  /**
   * Signed in, but the credential would bill an API account. `signInError`:
   * the sign-in started to replace it didn't finish.
   */
  | { kind: "wrong_billing"; status: AgentHarnessStatus; signInError?: string }
  /**
   * Signed in, but no subscription could be confirmed on the login (a Claude
   * account without a Pro or Max plan, an unrecognised login type). Not an
   * API login, so the card must not say it would bill API credits.
   */
  | { kind: "unconfirmed_billing"; status: AgentHarnessStatus; signInError?: string }
  | { kind: "ready"; status: AgentHarnessStatus };

export type AgentReadinessKind = AgentReadiness["kind"];

/** A sign-in the panel started, stamped with when its POST returned. */
export type AgentSignInAttempt = AgentSignInStart & { startedAt: number };

export interface DeriveReadinessInput {
  status?: AgentHarnessStatus;
  /** When the request that produced `status` was sent (ms epoch). */
  statusCheckedAt?: number;
  /** The panel's latest sign-in request for this harness, if any. */
  signIn?: AgentSignInAttempt | null;
  /** Error from the status route, if the last check failed. */
  fetchError?: string | null;
}

export function isHarnessReady(status: AgentHarnessStatus | undefined): boolean {
  return !!status && status.installed && status.signedIn && status.billing === "subscription";
}

export function deriveAgentReadiness({
  status,
  statusCheckedAt,
  signIn,
  fetchError,
}: DeriveReadinessInput): AgentReadiness {
  if (!status) {
    return fetchError ? { kind: "unavailable", message: fetchError } : { kind: "loading" };
  }
  if (!status.installed) return { kind: "not_installed", status };
  if (isHarnessReady(status)) return { kind: "ready", status };

  // The panel's own attempt only speaks for the gap between its POST returning
  // and the next status check: after that, the server's account of the flow wins
  // (a flow that timed out must not read as "waiting" forever).
  const attemptIsNewer = !!signIn && (statusCheckedAt === undefined || statusCheckedAt < signIn.startedAt);

  // A running sign-in comes first, also over a login that can't run: that
  // sign-in is how the user replaces it, and it may need a device code or link.
  if (status.signIn.state === "pending") {
    return {
      kind: "signing_in",
      status,
      url: status.signIn.url ?? signIn?.url,
      userCode: status.signIn.userCode ?? signIn?.userCode,
    };
  }
  if (attemptIsNewer && signIn.state === "pending") {
    return { kind: "signing_in", status, url: signIn.url, userCode: signIn.userCode };
  }

  if (status.signedIn) {
    // The server keeps a failed attempt until the next one starts, so its error
    // rides along on the billing card rather than replacing it.
    const signInError =
      (attemptIsNewer && signIn.state === "failed" ? signIn.message : undefined) ??
      (status.signIn.state === "failed" ? status.signIn.error : undefined);
    const kind = status.billing === "api" ? "wrong_billing" : "unconfirmed_billing";
    return signInError ? { kind, status, signInError } : { kind, status };
  }

  if (status.signIn.state === "failed") {
    return {
      kind: "sign_in_failed",
      status,
      message: status.signIn.error || "Sign-in didn't finish. Try again, or run the command below in a terminal.",
    };
  }
  if (attemptIsNewer && signIn.state === "failed") {
    return {
      kind: "sign_in_failed",
      status,
      message: signIn.message || "Sign-in couldn't start. Run the command below in a terminal instead.",
    };
  }
  return { kind: "signed_out", status };
}

/** Whether the panel should poll the status route for this harness. */
export function shouldPollReadiness(readiness: AgentReadiness): boolean {
  return readiness.kind === "signing_in";
}

export type AgentStatusTone = "ready" | "attention" | "blocked" | "unknown";

/** The colour of the harness dot in the panel header. */
export function readinessTone(readiness: AgentReadiness): AgentStatusTone {
  switch (readiness.kind) {
    case "ready":
      return "ready";
    case "signed_out":
    case "signing_in":
    case "sign_in_failed":
      return "attention";
    case "not_installed":
    case "wrong_billing":
    case "unconfirmed_billing":
      return "blocked";
    default:
      return "unknown";
  }
}

export const HARNESS_LABELS: Record<AgentHarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * What each harness runs on, in the words the panel uses. The app guarantees
 * only what it enforces: never an API key. The vendor may still bill usage past
 * the plan (Claude extra usage, Codex credits), so the copy says so rather than
 * promising the agent costs nothing beyond the plan.
 */
export const HARNESS_BILLING_COPY: Record<
  AgentHarnessId,
  {
    plan: string;
    /** The sign-in card's line. */
    runsOn: string;
    /** The shorter line under a fresh chat. */
    footer: string;
    /** Under the sign-in button: whose sign-in it opens. */
    signInNote: string;
  }
> = {
  claude: {
    plan: "Claude Pro or Max",
    runsOn:
      "Runs on your Claude subscription through Claude Code — never an API key. Turns count toward your plan's usage limits; when the included usage runs out, the agent stops instead of using extra usage.",
    footer: "Runs on your Claude plan's usage limits through Claude Code — never an API key. Stops at the limit instead of using extra usage.",
    signInNote: "Opens Claude Code's own sign-in in your browser. Node Banana never sees your password or tokens.",
  },
  codex: {
    plan: "ChatGPT",
    runsOn:
      "Runs on your ChatGPT plan through Codex — never an API key. Turns count toward your plan's Codex limits; when the included usage runs out, the agent stops instead of spending credits.",
    footer: "Runs on your ChatGPT plan's Codex limits through Codex — never an API key. Stops at the limit instead of spending credits.",
    signInNote: "Opens OpenAI's sign-in for Codex in your browser. Node Banana never sees your password or tokens.",
  },
};

/**
 * Whether the vendor CLI opens its sign-in page itself. Claude Code does, and
 * the panel never shows the URL it prints: that one is the manual flow, which
 * ends in a code pasted back into the CLI, and relaying it would put the app
 * between the user and their credential. Its fallback is the terminal command.
 * Codex's app-server hands the URL to the client, so the panel opens it.
 */
export const HARNESS_CLI_OPENS_BROWSER: Record<AgentHarnessId, boolean> = {
  claude: true,
  codex: false,
};

/** Fallback terminal commands, used until the status route has answered. */
export const HARNESS_SIGN_IN_COMMANDS: Record<AgentHarnessId, string> = {
  claude: "claude auth login",
  codex: "codex login",
};
