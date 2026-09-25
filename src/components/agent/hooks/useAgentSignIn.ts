"use client";

import { useCallback, useState } from "react";
import { startAgentSignIn } from "@/lib/agent/client/api";
import { HARNESS_CLI_OPENS_BROWSER, type AgentSignInAttempt } from "@/lib/agent/client/readiness";
import { safeExternalUrl } from "@/lib/agent/client/request";
import type { AgentHarnessId, AgentSignInOptions } from "@/lib/agent/types";

export interface UseAgentSignInResult {
  /** The latest attempt per harness, for the sign-in card. */
  attempts: Partial<Record<AgentHarnessId, AgentSignInAttempt>>;
  /** The harness whose sign-in request is in flight. */
  starting: AgentHarnessId | null;
  /** `force`: after a turn the vendor rejected, when the CLI's own status may still read signed in. */
  start: (harness: AgentHarnessId, options?: AgentSignInOptions) => Promise<AgentSignInAttempt>;
}

/**
 * Starts the vendor's own sign-in flow (POST /api/agent/sign-in) and opens the
 * page it returns unless the CLI already did. The app never handles
 * credentials: the CLI completes the login itself and the status route reports
 * the result.
 */
export function useAgentSignIn(): UseAgentSignInResult {
  const [attempts, setAttempts] = useState<Partial<Record<AgentHarnessId, AgentSignInAttempt>>>({});
  const [starting, setStarting] = useState<AgentHarnessId | null>(null);

  const start = useCallback(async (harness: AgentHarnessId, options: AgentSignInOptions = {}) => {
    setStarting(harness);
    let attempt: AgentSignInAttempt;
    try {
      const result = await startAgentSignIn(harness, options);
      attempt = { ...result, startedAt: Date.now() };
      // Claude Code opens the page itself; opening it here too would give two tabs.
      const url = result.state === "pending" && !HARNESS_CLI_OPENS_BROWSER[harness] ? safeExternalUrl(result.url) : null;
      // May be blocked as a popup after the await; the card shows the link as a fallback.
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      attempt = {
        state: "failed",
        message: `Couldn't start sign-in: ${error instanceof Error ? error.message : String(error)}`,
        startedAt: Date.now(),
      };
    } finally {
      setStarting(null);
    }
    setAttempts((previous) => ({ ...previous, [harness]: attempt }));
    return attempt;
  }, []);

  return { attempts, starting, start };
}
