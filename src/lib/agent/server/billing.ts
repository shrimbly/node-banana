/**
 * The billing verdict both harnesses reach about a login. Server-only.
 *
 * The rule is the same for both vendors: only a subscription login (Claude
 * Pro/Max, a ChatGPT plan) may run a turn. Anything that would bill API
 * credits or a cloud account is refused with a plain-words `problem`.
 */

import type { AgentBilling, AgentHarnessStatus, AgentSignInOptions } from "../types";

export interface BillingVerdict {
  signedIn: boolean;
  billing: AgentBilling;
  account?: { email?: string; plan?: string };
  /** Why the agent cannot run on this login. Absent exactly when billing is "subscription". */
  problem?: string;
}

/** Whether a harness may run a turn right now. */
export function isHarnessReady(status: Pick<AgentHarnessStatus, "installed" | "signedIn" | "billing">): boolean {
  return status.installed && status.signedIn && status.billing === "subscription";
}

/**
 * Options for a harness's `startSignIn` (the contract's AgentSignInOptions).
 * `force` starts the vendor's sign-in even when the local credentials look
 * fine — for a login the vendor has rejected (expired or revoked) that the
 * CLI's status can't see.
 */
export type SignInOptions = AgentSignInOptions;
