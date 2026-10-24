import { cn } from "@/components/nodes/ui/cn";
import { AUDIO_ROW_EXPANDED_PX, AUDIO_ROW_PX, AUDIO_ROWS_CAP, AUDIO_STRIP_PX } from "@/lib/stitch/audioLayout";

/**
 * The Stitch editor's class constants and geometry, in one place so the
 * boards' values are not scattered through the components.
 */

/** Floating chips (delta, snap, dB readout): the Tooltip skin. */
export const EDITOR_CHIP =
  "rounded-md squircle border border-white/10 bg-neutral-950 shadow-[0_4px_12px_rgba(0,0,0,0.5)] px-2 py-1 text-[10px] font-medium leading-3";

/**
 * The rail's actions (Split at playhead, Reset trim, Remove clip): a text row with no box, its icon in ink-3 at the
 * content's left edge (the row's padding hangs into the rail's), the key shown at the right on hover or focus.
 */
export const RAIL_ACTION =
  "group/action -mx-2 h-9 w-[calc(100%+16px)] shrink-0 flex items-center gap-2.5 px-2 rounded-md text-left text-[13px] text-neutral-300 transition-colors hover:bg-white/4 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-neutral-300";

/** The home's 28px icon button: an edit row's ⋯ (the top row's folder button is a HEADER_ICON_BUTTON). */
export const ICON_BUTTON =
  "h-7 w-7 inline-flex items-center justify-center rounded-lg text-neutral-400 transition-colors hover:text-neutral-100 hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400";

/**
 * The timeline's quiet text buttons under its rows: "+ Audio", and Line up in Stacked. Their focus ring is drawn
 * inside them: the line they sit in ends 2px under them, at the pane's (or the dialog's) bottom edge.
 */
export const TEXT_GHOST =
  "h-6 px-1.5 inline-flex items-center gap-1 rounded-md text-xs text-ink-3 transition-colors hover:text-neutral-100 hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40 disabled:text-neutral-600 disabled:hover:bg-transparent";

/** A DialogButton or DialogCloseButton in the editor (the picker's Close and footer, the sheets, the banner's actions): the editor's white focus ring, not the dialogs' blue one. */
export const DIALOG_BUTTON_RING = "focus-visible:ring-white/40";

/** The quiet text button under a notice that something failed: Try again (the home, the library). */
export const QUIET_BUTTON =
  "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";

/**
 * A few choices side by side (the rail's volume curve; the library filters' Kind and Sort): a row on the field
 * ground, the chosen segment lifted.
 */
export const SEGMENTS = "flex gap-0.5 rounded-lg bg-edit-field p-0.5";
export const SEGMENT =
  "h-7 min-w-0 flex-1 whitespace-nowrap rounded-md px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:opacity-40";
export const SEGMENT_ON = "bg-neutral-800 font-medium text-neutral-100";
export const SEGMENT_OFF = "text-ink-3 hover:text-neutral-200";

/** The headers' height (the view's and the dialog's h-14): what sits over the stage in the editor's column. */
export const HEADER_PX = 56;

/** The headers' 32px icon buttons (Undo, Redo, ⋯, Show media): dimmed when off, filled while open. */
export const HEADER_ICON_BUTTON =
  "h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-neutral-400 transition-colors hover:text-neutral-100 hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 aria-expanded:bg-edit-pressed aria-expanded:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent";

/** The one white button in a header: Render, Done. */
export const HEADER_PRIMARY =
  "h-8 shrink-0 inline-flex items-center rounded-lg bg-neutral-100 px-4 text-[13px] font-semibold text-neutral-950 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-neutral-100";

/** A header's quiet text button: Save, Cancel. */
export const HEADER_GHOST =
  "h-8 shrink-0 inline-flex items-center rounded-lg px-3 text-[13px] font-medium text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent";

/** Stop, outlined beside the render's progress. */
export const HEADER_OUTLINE =
  "h-8 shrink-0 inline-flex items-center rounded-lg border border-neutral-800 px-3.5 text-[13px] font-medium text-neutral-100 transition-colors hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";

/** A header's title: the edit's name, or "Edit video" in the dialog. */
export const HEADER_TITLE = "font-display text-[15px] font-medium leading-[18px] tracking-[-0.02em] text-neutral-100";

/**
 * The control row's 32px icon buttons under the video: quiet, and white on the pressed fill while on (Snap, Mute all,
 * Crossfade, Track | Stacked).
 */
export const CONTROL_BUTTON = cn(
  HEADER_ICON_BUTTON,
  "aria-pressed:bg-edit-pressed aria-pressed:text-neutral-100 aria-disabled:cursor-progress",
);

/** The rail's fields (Start, In, Out): 32px on the field ground, 13px tabular figures, as wide as their column. */
export const TIMECODE_WELL =
  "h-8 w-full min-w-0 rounded-md border-0 bg-edit-field px-2.5 text-[13px] tabular-nums text-neutral-200 outline-none transition-colors placeholder:text-neutral-500 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50";

/** The timeline's hairline top edge, px. */
export const TIMELINE_EDGE_PX = 1;
/** The ruler over the lanes, px. */
const RULER_PX = 28;
/** Track's clips row: the 64px clips with 8px over and under them, px. */
const CLIP_ROW_PX = 80;

/**
 * Pixel sizes from the boards (Index-Editor-Clip, -Audio, -Focus; Trim, Volume) the timeline lane computes with. The
 * shell's own (header 56, rail 280) are its Tailwind classes; the stage's room and its control row are EditorStage's.
 */
export const GEOMETRY = {
  /** The least the timeline takes: its 1px top edge, the ruler, Track's clips row, one audio row and the strip. */
  timeline: TIMELINE_EDGE_PX + RULER_PX + CLIP_ROW_PX + AUDIO_ROW_PX + AUDIO_STRIP_PX,
  ruler: RULER_PX,
  /** The playhead's head on the ruler, from its top: a snap guide carries its line on from there. */
  playheadHead: 12,
  /** Track's clips row: the 64px clips with 8px over and under them (a press there starts the selection box). */
  clipRow: CLIP_ROW_PX,
  clipTop: 8,
  clipHeight: 64,
  audioRow: AUDIO_ROW_PX,
  audioRowExpanded: AUDIO_ROW_EXPANDED_PX,
  /** An audio clip's block sits at its row's top, 8px over the next row. */
  audioBlockTop: 0,
  audioBlock: 44,
  audioBlockExpanded: 120,
  /** 0:00 sits this far into the lanes: the timeline's 20px side padding, which the row controls float in. */
  origin: 20,
  frameCell: 56,
  handle: 10,
  addSlot: 44,
  addSlotGap: 6,
  emptySlot: 160,
  /** The lane's margin after the add slot, and the empty lane's placeholder's right margin. */
  endMargin: 20,
  /** One clip per row in Stacked. */
  stackRow: 52,
  stackClipTop: 6,
  stackClipHeight: 40,
  /** 3.5 rows: the rows scroll vertically past this. */
  stackRowsCap: 182,
  /** Under the audio rows: "+ Audio" and Line up, the "New row" drop target in the lanes. */
  audioStrip: AUDIO_STRIP_PX,
  /** Audio rows shown before the rest scroll. */
  audioRowsCap: AUDIO_ROWS_CAP,
  /**
   * The stage keeps at least this much height, its padding and the control row under the video included (a 240px
   * frame): the timeline gives up room below it first.
   */
  stageFloor: 344,
  /** Stacked's rows view is never capped below one and a half rows, so it still reads as scrollable. */
  stackRowsFloor: 78,
} as const;

/** The room the lane keeps after the last clip: the add slot with its gap, and the end margin. Fit leaves it too. */
export const LANE_TRAILING_PX = GEOMETRY.addSlotGap + GEOMETRY.addSlot + GEOMETRY.endMargin;

/**
 * A selected clip's ring (video or audio, one or several): 2px of neutral-100 inside the box's edge, drawn over its
 * frames or waveform, under its handles and badges.
 */
export const SELECTED_RING = "pointer-events-none absolute inset-0 z-1 rounded-[inherit] border-2 border-neutral-100";

/** A clip (or slot) lifted to be dragged to a new place (design-spec §9.1). */
export const LIFTED_CLIP = "z-10 -translate-y-1.5 -rotate-[1.5deg] shadow-[0_12px_28px_rgba(0,0,0,0.6)]";

/** A clip (or slot) Stacked's body drag carries in time and across rows: on top, ringed and raised. */
export const MOVING_CLIP = "z-10 ring-2 ring-neutral-100 shadow-[0_8px_20px_rgba(0,0,0,0.5)] cursor-grabbing";

/** The edit menus' surface (the headers' ⋯, the clip menu): 220px, a hairline on neutral-900, 10px corners. */
export const EDIT_MENU_SURFACE = "w-[220px] overflow-visible rounded-[10px] border-neutral-800 bg-neutral-900 p-1 shadow-edit-menu";

/**
 * Their row: 32px in 13px type, lit on hover and while its submenu is open; on keyboard focus also ringed in the
 * editor's white, inside the row (the faint fill alone barely shows against the menu).
 */
export const EDIT_MENU_ROW =
  "h-8 rounded-md py-0 text-[13px] text-neutral-200 hover:bg-white/6 focus-visible:bg-white/6 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40 disabled:cursor-default disabled:text-neutral-600 disabled:opacity-100";

/** What a row says at its right (Loop's "Off", a clip menu's key): readable on a lit row too. */
export const EDIT_MENU_VALUE = "text-neutral-400";

/** A muted line in them: a group's label and note, a footer, the clip menu's heading. */
export const EDIT_MENU_MUTED = "px-2.5 text-xs leading-4 tabular-nums text-ink-3";

/** The hairline between their groups of rows. */
export const EDIT_MENU_DIVIDER = "my-1 border-neutral-800";

/** The editor's panel, marked for code outside it that hands focus back (the library picker): not its label. */
export const STITCH_EDITOR_PANEL = "data-stitch-editor";

/**
 * The element focus goes back to inside the editor: the dialog's panel, or the Edit video view's editor column (which
 * carries STITCH_EDITOR_PANEL and is no dialog). The same element in the dialog, so nothing changes there.
 */
export const EDITOR_PANEL_SELECTOR = `[role="dialog"], [${STITCH_EDITOR_PANEL}]`;
