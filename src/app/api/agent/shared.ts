/**
 * Shared helpers for the `/api/agent/*` routes.
 *
 * A NON-route module (no HTTP handler exports) so the handlers and their tests
 * can share it without Next.js treating the extra exports as routes.
 */

import { AGENT_HARNESS_IDS, type AgentHarnessId, type AgentHarnessStatus } from "@/lib/agent/types";

/**
 * The largest chat request read. A request carries the chat's messages and a
 * media-free canvas snapshot; a long conversation on a big canvas stays far
 * below this. Anything larger is refused before it is buffered or parsed.
 */
export const AGENT_CHAT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The largest sign-in request read: it only names a harness (and `force`). */
export const AGENT_SIGN_IN_MAX_BODY_BYTES = 16 * 1024;

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; problem: "too_large" | "not_json" };

/**
 * Read a JSON body without holding more than `maxBytes` of it. A declared
 * `Content-Length` over the limit is refused unread; a body that streams past
 * it is dropped mid-read, so a client that sends endlessly is never buffered.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, problem: "too_large" };
  if (!request.body) return { ok: false, problem: "not_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, problem: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // The client went away mid-body.
    return { ok: false, problem: "not_json" };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, problem: "not_json" };
  }
}

/** "2 MB", "16 KB": the limit as the refusal names it. */
export function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * The status without the account's email address, which only the person at
 * this machine sees. The plan stays, so the panel can still say who pays.
 */
export function withoutAccountEmail(status: AgentHarnessStatus): AgentHarnessStatus {
  if (!status.account?.email) return status;
  const { plan } = status.account;
  return { ...status, account: plan ? { plan } : {} };
}

export function isAgentHarnessId(value: unknown): value is AgentHarnessId {
  return typeof value === "string" && (AGENT_HARNESS_IDS as readonly string[]).includes(value);
}

/** For messages written before a harness could be asked for its own label. */
export const AGENT_HARNESS_LABELS: Record<AgentHarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const SIGN_IN_COMMANDS: Record<AgentHarnessId, string> = {
  claude: "claude auth login",
  codex: "codex login",
};

export function unknownHarnessMessage(value: unknown): string {
  const shown = typeof value === "string" ? `"${value}"` : String(value);
  return `Unknown agent harness ${shown}. Use one of: ${AGENT_HARNESS_IDS.join(", ")}.`;
}

/**
 * The status to report when asking the harness itself failed. Shaped like any
 * other not-ready status, so the panel shows its sign-in card with the reason
 * rather than breaking on a missing entry.
 */
export function unavailableHarnessStatus(id: AgentHarnessId, error: unknown): AgentHarnessStatus {
  const label = AGENT_HARNESS_LABELS[id];
  const reason = error instanceof Error ? error.message : String(error);
  return {
    id,
    label,
    installed: false,
    signedIn: false,
    billing: "unknown",
    models: [],
    signIn: { state: "idle" },
    problem: `Could not check ${label}: ${reason}`,
    signInCommand: SIGN_IN_COMMANDS[id],
  };
}
