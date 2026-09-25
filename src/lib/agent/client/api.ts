/**
 * Browser calls to the agent routes other than the chat stream (which goes
 * through useChat's transport).
 */

import type {
  AgentHarnessId,
  AgentSignInOptions,
  AgentSignInRequestBody,
  AgentSignInStart,
  AgentStatusResponse,
} from "../types";

export const AGENT_CHAT_API = "/api/agent/chat";
export const AGENT_STATUS_API = "/api/agent/status";
export const AGENT_SIGN_IN_API = "/api/agent/sign-in";

/** Pulls a readable reason out of a failed response (JSON `error`/`message`, else text, else status). */
async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: unknown; message?: unknown };
      const value = json.error ?? json.message;
      detail = typeof value === "string" ? value : "";
    } catch {
      detail = text.trim().slice(0, 200);
    }
  } catch {
    // Body unreadable: the status line is all we have.
  }
  return detail || `${response.status} ${response.statusText}`.trim();
}

/** GET /api/agent/status — every harness, or just one with `harness`. */
export async function fetchAgentStatus(
  harness?: AgentHarnessId,
  signal?: AbortSignal,
): Promise<AgentStatusResponse> {
  const url = harness ? `${AGENT_STATUS_API}?harness=${encodeURIComponent(harness)}` : AGENT_STATUS_API;
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Couldn't check the agent status: ${await describeFailure(response)}`);
  }
  const body = (await response.json()) as Partial<AgentStatusResponse>;
  return { harnesses: Array.isArray(body.harnesses) ? body.harnesses : [] };
}

/**
 * POST /api/agent/sign-in — starts the vendor's own sign-in flow through its
 * CLI. `force` (after a turn the vendor rejected) starts it even though the
 * CLI's local status still reads signed in.
 */
export async function startAgentSignIn(
  harness: AgentHarnessId,
  options: AgentSignInOptions = {},
): Promise<AgentSignInStart> {
  const payload: AgentSignInRequestBody = options.force ? { harness, force: true } : { harness };
  const response = await fetch(AGENT_SIGN_IN_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return (await response.json()) as AgentSignInStart;

  // The route answers failures as an AgentSignInStart too; use its message as-is.
  const fallback = response.clone();
  try {
    const body = (await response.json()) as Partial<AgentSignInStart>;
    if (body.state === "failed" && typeof body.message === "string" && body.message) {
      return { state: "failed", message: body.message };
    }
  } catch {
    // Not JSON: describe the raw response below.
  }
  return { state: "failed", message: `Couldn't start sign-in: ${await describeFailure(fallback)}` };
}
