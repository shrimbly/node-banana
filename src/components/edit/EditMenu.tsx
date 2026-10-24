"use client";

import { resolvePlatform, revealLabel } from "@/components/assets/assetFormat";
import { MoreMenu, type ActionMenuEntry } from "@/components/stitch/ActionMenu";
import { useLoopMenuEntry } from "@/components/stitch/sequenceMenu";
import { getRecorderLibraryStatus } from "@/lib/assets/client/recorder";
import { useEditProjectStore } from "@/store/editProjectStore";

/** "Show in Finder", "Show in Explorer" or "Show in folder", for the library's platform. */
export function revealText(): string {
  return revealLabel(resolvePlatform(getRecorderLibraryStatus()));
}

/**
 * The open edit's ⋯ in the header: Rename (in place), Duplicate, Show in
 * Finder; Loop (its row reads the count; Off, 2×, 3× beside it, as in the
 * dialog's menu); Delete… (to the Trash, after a confirm); and
 * under them, in a muted line, what the sequence is (`meta`). New edit and
 * the other edits are on the home, a click away on the breadcrumb's Edits.
 */
export function EditMenu({ onRename, meta }: { onRename: () => void; meta: string }) {
  const loop = useLoopMenuEntry();

  const store = () => useEditProjectStore.getState();
  const entries: ActionMenuEntry[] = [
    { kind: "item", label: "Rename", onSelect: onRename },
    { kind: "item", label: "Duplicate", onSelect: () => void store().duplicate() },
    { kind: "item", label: revealText(), onSelect: () => void store().reveal() },
    { kind: "divider" },
    loop,
    { kind: "divider" },
    { kind: "item", label: "Delete…", onSelect: () => store().requestDelete() },
  ];

  return <MoreMenu label="Edit menu" entries={entries} footer={meta} />;
}
