import { formatDuration, formatRelativeDate } from "@/components/assets/assetFormat";
import type { EditSummary } from "@/lib/edits/types";

/**
 * What an edit holds, for the home's preview caption ("3 clips · 0:12 · edited
 * 2h ago") and, for a screen reader, its row ("3 clips, 0:12, edited 2h ago").
 */
export function editCardMeta(edit: Pick<EditSummary, "clipCount" | "durationSec" | "updatedAt">, now = Date.now()) {
  const clips = `${edit.clipCount} clip${edit.clipCount === 1 ? "" : "s"}`;
  const length = formatDuration(edit.durationSec);
  const when = formatRelativeDate(edit.updatedAt, now);
  // "edited 2h ago", "edited yesterday", "edited Thu 16 Oct": only the relative words start lower case
  const spoken = when === "Just now" || when === "Yesterday" ? when.toLowerCase() : when;
  return { text: `${clips} · ${length} · edited ${spoken}`, label: `${clips}, ${length}, edited ${spoken}` };
}
