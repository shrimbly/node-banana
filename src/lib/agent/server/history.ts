/**
 * Seeding a fresh vendor session with the chat so far. Server-only.
 *
 * Used when there is no session to resume: the first turn on a harness, a
 * switch between harnesses mid-chat, a Claude session that no longer exists,
 * or a Codex app-server that restarted and lost its (ephemeral) threads.
 */

import type { HarnessTurnParams } from "../types";

/** Keep the replay well inside any model's context; the newest turns matter most. */
export const HISTORY_CHAR_BUDGET = 24_000;

/**
 * `prompt` preceded by the earlier conversation, newest turns kept when the
 * whole history does not fit the budget. Returns `prompt` unchanged when
 * there is no history.
 */
export function withConversationHistory(
  history: HarnessTurnParams["history"],
  prompt: string,
  budget: number = HISTORY_CHAR_BUDGET,
): string {
  const turns = history.filter((turn) => turn.text.trim().length > 0);
  if (turns.length === 0) return prompt;

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    let line = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.trim()}`;
    if (line.length > budget) line = `${line.slice(0, budget)}…`;
    if (used + line.length > budget && lines.length > 0) {
      dropped = i + 1;
      break;
    }
    lines.unshift(line);
    used += line.length;
  }

  const note =
    dropped > 0
      ? `(${dropped} earlier message${dropped === 1 ? "" : "s"} omitted.)\n`
      : "";
  return [
    "<conversation_history>",
    "Earlier messages in this chat, for context. The canvas may have changed since; " +
      "the canvas in the current message is authoritative.",
    `${note}${lines.join("\n\n")}`,
    "</conversation_history>",
    "",
    prompt,
  ].join("\n");
}
