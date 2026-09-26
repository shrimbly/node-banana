"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentHarnessId, AgentHarnessStatus } from "../types";
import { fetchAgentStatus } from "./api";

export const AGENT_STATUS_POLL_MS = 2000;
/** Coming back to the window re-checks, but not more often than this. */
const FOCUS_RECHECK_MS = 3000;

export interface AgentStatusState {
  statuses: Partial<Record<AgentHarnessId, AgentHarnessStatus>>;
  /** When the request behind each harness's current status was sent (ms epoch). */
  checkedAt: Partial<Record<AgentHarnessId, number>>;
  /** The last check failed (the previous statuses, if any, are kept). */
  error: string | null;
}

export interface UseAgentStatusOptions {
  /** Checks run only while this is true (the panel is open). */
  active: boolean;
  /** Poll this harness every `intervalMs` while set (a sign-in is in progress). */
  pollHarness?: AgentHarnessId | null;
  intervalMs?: number;
}

export interface UseAgentStatusResult extends AgentStatusState {
  /** Re-check one harness, or all of them. Never throws. */
  refresh: (harness?: AgentHarnessId) => Promise<void>;
}

/**
 * Status of the agent harnesses (installed, signed in, billing, models) from
 * GET /api/agent/status. Checks when the panel opens, when the window regains
 * focus, and every two seconds for a harness that is mid sign-in.
 */
export function useAgentStatus({
  active,
  pollHarness = null,
  intervalMs = AGENT_STATUS_POLL_MS,
}: UseAgentStatusOptions): UseAgentStatusResult {
  const [state, setState] = useState<AgentStatusState>({ statuses: {}, checkedAt: {}, error: null });
  const controllers = useRef(new Set<AbortController>());
  const lastCheckRef = useRef(0);

  const refresh = useCallback(async (harness?: AgentHarnessId) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const sentAt = Date.now();
    lastCheckRef.current = sentAt;
    try {
      const { harnesses } = await fetchAgentStatus(harness, controller.signal);
      setState((previous) => {
        const statuses = { ...previous.statuses };
        const checkedAt = { ...previous.checkedAt };
        for (const status of harnesses) {
          // A slower, older request must not overwrite a newer answer.
          if ((checkedAt[status.id] ?? 0) > sentAt) continue;
          statuses[status.id] = status;
          checkedAt[status.id] = sentAt;
        }
        return { statuses, checkedAt, error: null };
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setState((previous) => ({ ...previous, error: message }));
    } finally {
      controllers.current.delete(controller);
    }
  }, []);

  // Check everything each time the panel opens: a sign-in may have happened in a terminal meanwhile.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      if (Date.now() - lastCheckRef.current >= FOCUS_RECHECK_MS) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !pollHarness) return;
    let inFlight = false;
    const timer = setInterval(() => {
      // A status check spawns the vendor CLI; never stack them.
      if (inFlight) return;
      inFlight = true;
      void refresh(pollHarness).finally(() => {
        inFlight = false;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, pollHarness, intervalMs, refresh]);

  useEffect(() => {
    const pending = controllers.current;
    return () => {
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, []);

  return { ...state, refresh };
}
