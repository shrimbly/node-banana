"use client";

import {
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  FolderInput,
  History,
  Maximize2,
  RotateCcw,
  SquareCheck,
  Star,
  Tag,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuDivider, MenuItem, MenuSectionLabel, MenuShortcut, MenuSurface } from "@/components/ui/Menu";
import { openWorkflowBlockedReason, type OpenWorkflowMode } from "@/lib/assets/client/openWorkflow";
import type { AssetSelection, AssetView } from "@/lib/assets/types";
import { bulkFavoriteOp, selectionCount, selectionHas, useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { formatCount, resolvePlatform, revealLabel } from "./assetFormat";
import {
  canZip,
  copyPrompt,
  downloadZip,
  exportAssets,
  isDesktopApp,
  openWorkflowFor,
  recordsOf,
  removeSelection,
  requestPermanentDelete,
  restoreSelection,
  revealAssetFile,
  saveCopy,
  selectionOf,
  toggleFavorite,
} from "./assetActions";

const MENU_WIDTH = 248;
const EDGE = 8;

export interface MenuEntry {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** Why it cannot be chosen; shown as the row's hint. */
  disabledReason?: string | null;
  hint?: string;
  danger?: boolean;
}

type MenuPart = MenuEntry | "divider";

/** "Open workflow", or for a project's asset "Open project" and "Open as it was when made". */
export function workflowActions(asset: AssetView): { mode: OpenWorkflowMode; label: string; secondary?: boolean }[] {
  // A render from the Edit video view, or a file the user added, has no workflow snapshot to open
  if (asset.producer?.nodeType === "editProject" || asset.origin === "uploaded") return [];
  if (asset.imported) return [{ mode: "project", label: "Open project" }];
  if (asset.workflow.projectPath) {
    return [
      { mode: "project", label: "Open project" },
      { mode: "snapshot", label: "Open as it was when made", secondary: true },
    ];
  }
  return [{ mode: "snapshot", label: "Open workflow" }];
}

function singleEntries(asset: AssetView, view: string, platform: string, close: () => void): MenuPart[] {
  const store = useAssetStore.getState();
  const selected = selectionHas(store.selection, asset.id);
  const act = (run: () => void) => () => {
    close();
    run();
  };
  const trashEntries: MenuPart[] =
    view === "trash"
      ? [
          { key: "restore", label: "Restore", icon: RotateCcw, onSelect: act(() => restoreSelection(selectionOf([asset.id]))) },
          { key: "delete", label: "Delete permanently…", icon: Trash2, danger: true, onSelect: act(() => requestPermanentDelete(selectionOf([asset.id]), 1)) },
        ]
      : view === "missing"
        ? [
            { key: "remove", label: "Remove from library…", icon: Trash2, danger: true, onSelect: act(() => removeSelection(selectionOf([asset.id]))) },
          ]
        : [{ key: "trash", label: "Trash", icon: Trash2, hint: "⌫", onSelect: act(() => void store.runBulk(selectionOf([asset.id]), { action: "trash" })) }];

  return [
    { key: "open", label: "Open", icon: Maximize2, hint: "↵", onSelect: act(() => store.openDetail(asset.id)) },
    ...workflowActions(asset).map<MenuEntry>((action) => ({
      key: `workflow-${action.mode}`,
      label: action.label,
      icon: action.secondary ? History : action.mode === "project" ? FolderOpen : Workflow,
      disabledReason: openWorkflowBlockedReason(asset, action.mode),
      onSelect: act(() => void openWorkflowFor(asset, action.mode)),
    })),
    "divider",
    {
      key: "reveal",
      label: revealLabel(platform),
      icon: ExternalLink,
      disabledReason: asset.missing ? "The file is missing" : null,
      onSelect: act(() => void revealAssetFile(asset)),
    },
    {
      key: "copy-file",
      label: isDesktopApp() ? "Save a copy…" : "Download",
      icon: isDesktopApp() ? FolderInput : Download,
      disabledReason: asset.missing ? "The file is missing" : null,
      onSelect: act(() => saveCopy(asset)),
    },
    {
      key: "copy-prompt",
      label: "Copy prompt",
      icon: Copy,
      disabledReason: asset.prompt ? null : "No prompt",
      onSelect: act(() => void copyPrompt(asset)),
    },
    "divider",
    {
      key: "tags",
      label: "Tags…",
      icon: Tag,
      onSelect: () => store.openPopover({ kind: "tags", x: store.popover?.kind === "menu" ? store.popover.x : 0, y: store.popover?.kind === "menu" ? store.popover.y : 0, selection: selectionOf([asset.id]) }),
    },
    { key: "favorite", label: asset.favorite ? "Unfavorite" : "Favorite", icon: Star, onSelect: act(() => toggleFavorite(asset)) },
    { key: "select", label: selected ? "Deselect" : "Select", icon: SquareCheck, onSelect: act(() => store.toggleSelect(asset.id)) },
    "divider",
    ...trashEntries,
  ];
}

function selectionEntries(selection: AssetSelection, count: number, view: string, close: () => void): MenuPart[] {
  const store = useAssetStore.getState();
  const act = (run: () => void) => () => {
    close();
    run();
  };
  const favorite = bulkFavoriteOp(store);
  const records = recordsOf(selection);
  const bytes = selection.mode === "ids" ? records.reduce((sum, asset) => sum + asset.bytes, 0) : store.totalBytes;
  const zippable = !isDesktopApp() && selection.mode === "ids" && records.length === count && canZip(count, bytes);
  const at = store.popover?.kind === "menu" ? store.popover : { x: 0, y: 0 };

  return [
    { key: "tags", label: "Tags…", icon: Tag, onSelect: () => store.openPopover({ kind: "tags", x: at.x, y: at.y, selection }) },
    {
      key: "favorite",
      label: favorite.action === "favorite" ? "Favorite" : "Unfavorite",
      icon: Star,
      onSelect: act(() => void store.runBulk(selection, favorite)),
    },
    "divider",
    // Missing files have nothing to copy
    ...(view === "missing"
      ? []
      : ([
          { key: "export", label: "Export…", icon: FolderInput, onSelect: act(() => void exportAssets(selection)) },
          ...(zippable ? [{ key: "download", label: "Download", icon: Download, onSelect: act(() => void downloadZip(records)) } satisfies MenuEntry] : []),
          "divider",
        ] satisfies MenuPart[])),
    ...(view === "trash"
      ? [
          { key: "restore", label: "Restore", icon: RotateCcw, onSelect: act(() => restoreSelection(selection)) },
          { key: "delete", label: "Delete permanently…", icon: Trash2, danger: true, onSelect: act(() => requestPermanentDelete(selection, count)) },
        ]
      : view === "missing"
        ? [{ key: "remove", label: "Remove from library…", icon: Trash2, danger: true, onSelect: act(() => removeSelection(selection)) }]
        : [{ key: "trash", label: "Trash", icon: Trash2, hint: "⌫", onSelect: act(() => removeSelection(selection)) }]),
    { key: "clear", label: "Clear selection", onSelect: act(() => store.clearSelection()) },
  ];
}

/**
 * Right-click menu on a tile (Instrument skin). On a tile inside a larger
 * selection it acts on the selection; otherwise on that tile. Clamped to the
 * window, dismissed by an outside press or Escape (the view's key handler),
 * arrows move between rows. Rows that cannot be chosen say why.
 */
export function AssetContextMenu({ x, y, anchorId, useSelection }: { x: number; y: number; anchorId: string; useSelection: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closePopover = useAssetStore((state) => state.closePopover);
  const view = useAssetStore((state) => state.filters.view);
  const library = useAssetStore((state) => state.library);
  const selection = useAssetStore((state) => state.selection);
  const selectionTotal = useAssetStore((state) => state.selectionTotal);
  const asset = useAssetStore(
    (state) => state.items.find((item) => item.id === anchorId)?.asset ?? (state.detailAsset?.id === anchorId ? state.detailAsset : null),
  );
  // Blocked reasons follow the canvas's busy state
  useWorkflowStore((state) => state.isRunning || state.isSaving || state.pendingMediaSaves > 0);
  const [position, setPosition] = useState({ left: x, top: y });

  const close = () => {
    closePopover();
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-asset-tile="${anchorId}"]`)?.focus({ preventScroll: true }));
  };

  const count = useSelection ? selectionCount({ selection, selectionTotal }) : 1;
  const parts: MenuPart[] = useSelection
    ? selectionEntries(selection, count, view, close)
    : asset
      ? singleEntries(asset, view, resolvePlatform(library), close)
      : [];

  // Clamp to the window once the height is known
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - MENU_WIDTH - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    });
  }, [x, y, parts.length]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closePopover();
    };
    const onWheel = (event: WheelEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closePopover();
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("resize", closePopover);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", closePopover);
    };
  }, [closePopover]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % rows.length;
    else if (event.key === "ArrowUp") next = index <= 0 ? rows.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  if (parts.length === 0) return null;

  return (
    <MenuSurface
      ref={ref}
      role="menu"
      aria-label={useSelection ? `${formatCount(count)} selected` : "Asset"}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className="py-1"
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      {useSelection && <MenuSectionLabel className="px-2.5 pb-1 pt-1.5">{formatCount(count)} selected</MenuSectionLabel>}
      {parts.map((part, index) => {
        if (part === "divider") return <MenuDivider key={`divider-${index}`} role="separator" className="my-1" />;
        const Icon = part.icon;
        const disabled = !!part.disabledReason;
        return (
          <MenuItem
            key={part.key}
            role="menuitem"
            disabled={disabled}
            title={part.disabledReason ?? undefined}
            onClick={part.onSelect}
            className={cn(part.danger && "text-red-400 hover:text-red-300", disabled && "disabled:opacity-60")}
          >
            {Icon ? <Icon size={14} strokeWidth={1.75} className="shrink-0 text-neutral-400" /> : <span className="w-3.5 shrink-0" />}
            <span className="truncate">{part.label}</span>
            {part.disabledReason ? (
              <MenuShortcut className="max-w-[110px] truncate normal-case">{part.disabledReason}</MenuShortcut>
            ) : (
              part.hint && <MenuShortcut>{part.hint}</MenuShortcut>
            )}
          </MenuItem>
        );
      })}
    </MenuSurface>
  );
}
