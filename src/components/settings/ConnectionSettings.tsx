"use client";

import { EdgeAppearance, EdgeStyle, EdgeThickness } from "@/types";
import { EDGE_THICKNESS_PX } from "@/lib/edges/appearance";
import { HANDLE_TYPE_COLORS } from "@/lib/edges/colors";
import { gradientOpacities } from "@/components/edges/SharedEdgeGradients";
import { DialogEyebrow, DialogRow, DialogTextButton } from "@/components/ui/Dialog";
import { Slider, Switch } from "@/components/ui/Controls";
import { cn } from "@/components/nodes/ui/cn";

/**
 * The Noodles page of the settings dialog: how connections are drawn. Draft
 * state lives in the modal; this component only renders and reports changes.
 */

interface ConnectionSettingsProps {
  edgeStyle: EdgeStyle;
  appearance: EdgeAppearance;
  onEdgeStyleChange: (style: EdgeStyle) => void;
  onAppearanceChange: (appearance: EdgeAppearance) => void;
  /** Store the draft as the user's default for new workflows. */
  onSetDefault: () => void;
  defaultSaved: boolean;
}

const LINE_STYLES: { value: EdgeStyle; label: string }[] = [
  { value: "curved", label: "Curved" },
  { value: "angular", label: "Angular" },
  { value: "straight", label: "Straight" },
];

const THICKNESSES: { value: EdgeThickness; label: string }[] = [
  { value: "thin", label: "Thin" },
  { value: "regular", label: "Regular" },
  { value: "thick", label: "Thick" },
];

/**
 * The ink segmented control with radio semantics: line style and thickness
 * are announced as one choice among three, not as three toggles.
 */
function RadioSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 p-0.5 rounded-lg bg-card w-[232px] shrink-0">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex-1 h-7 px-2 rounded-md font-display text-xs tracking-[-0.01em] whitespace-nowrap transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
              active ? "bg-neutral-200 text-neutral-900 font-semibold" : "text-neutral-400 font-medium hover:text-neutral-200"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A path between two points in the given line style, for the preview only. */
function previewPath(style: EdgeStyle, sx: number, sy: number, tx: number, ty: number): string {
  if (style === "straight") return `M${sx},${sy} L${tx},${ty}`;
  const mx = (sx + tx) / 2;
  if (style === "angular") {
    const dir = ty > sy ? 1 : -1;
    const r = Math.min(8, Math.abs(ty - sy) / 2);
    if (r === 0) return `M${sx},${sy} L${tx},${ty}`;
    return `M${sx},${sy} L${mx - r},${sy} Q${mx},${sy} ${mx},${sy + dir * r} L${mx},${ty - dir * r} Q${mx},${ty} ${mx + r},${ty} L${tx},${ty}`;
  }
  return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
}

const PREVIEW_LINES = [
  { key: "image", color: HANDLE_TYPE_COLORS.image, from: [70, 16], to: [420, 32], active: true },
  { key: "text", color: HANDLE_TYPE_COLORS.text, from: [70, 32], to: [420, 48], active: false },
] as const;

/** Two noodles drawn the way the settings would draw them: one attached to a selection, one faded. */
export function ConnectionPreview({ edgeStyle, appearance }: { edgeStyle: EdgeStyle; appearance: EdgeAppearance }) {
  const strokeWidth = EDGE_THICKNESS_PX[appearance.thickness];
  return (
    <div
      className="h-[72px] rounded-lg bg-[#0f0f0f] overflow-hidden"
      style={{ backgroundImage: "radial-gradient(circle, #404040 0.5px, transparent 0.75px)", backgroundSize: "20px 20px" }}
      data-testid="connection-preview"
    >
      <svg viewBox="0 0 490 62" className="block w-full h-full" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          {PREVIEW_LINES.map((line) => {
            const [start, middle, end] = gradientOpacities(line.active, appearance.fadedOpacity);
            return (
              <linearGradient key={line.key} id={`connection-preview-${line.key}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={line.color} stopOpacity={start} />
                <stop offset="50%" stopColor={line.color} stopOpacity={middle} />
                <stop offset="100%" stopColor={line.color} stopOpacity={end} />
              </linearGradient>
            );
          })}
        </defs>
        <rect x="14" y="4" width="56" height="40" rx="6" fill="#262626" stroke="rgba(64,64,64,0.6)" />
        <rect x="420" y="20" width="56" height="40" rx="6" fill="#262626" stroke="rgba(64,64,64,0.6)" />
        {PREVIEW_LINES.map((line) => (
          <path
            key={line.key}
            d={previewPath(edgeStyle, line.from[0], line.from[1], line.to[0], line.to[1])}
            fill="none"
            stroke={appearance.gradient ? `url(#connection-preview-${line.key})` : line.color}
            strokeOpacity={appearance.gradient || line.active ? 1 : appearance.fadedOpacity}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            data-testid={`connection-preview-${line.key}`}
          />
        ))}
        {PREVIEW_LINES.map((line) => (
          <g key={`${line.key}-handles`}>
            <circle cx={line.from[0]} cy={line.from[1]} r="6" fill={line.color} stroke="#fff" strokeWidth="2" />
            <circle cx={line.to[0]} cy={line.to[1]} r="6" fill={line.color} stroke="#fff" strokeWidth="2" />
          </g>
        ))}
      </svg>
    </div>
  );
}

export function ConnectionSettings({
  edgeStyle,
  appearance,
  onEdgeStyleChange,
  onAppearanceChange,
  onSetDefault,
  defaultSaved,
}: ConnectionSettingsProps) {
  const update = (patch: Partial<EdgeAppearance>) => onAppearanceChange({ ...appearance, ...patch });
  const fadedPercent = Math.round(appearance.fadedOpacity * 100);

  return (
    <div>
      <ConnectionPreview edgeStyle={edgeStyle} appearance={appearance} />

      <DialogRow first title="Line style" description="Also toggled from the action bar" className="pb-3">
        <RadioSegmented label="Line style" options={LINE_STYLES} value={edgeStyle} onChange={onEdgeStyleChange} />
      </DialogRow>

      <DialogRow title="Thickness" description="Regular is 3px" className="py-3">
        <RadioSegmented
          label="Thickness"
          options={THICKNESSES}
          value={appearance.thickness}
          onChange={(thickness) => update({ thickness })}
        />
      </DialogRow>

      <DialogRow title="Faded connections" description="Opacity when not attached to a selected node" className="py-3">
        <Slider
          className="w-[232px] shrink-0"
          min={5}
          max={100}
          step={5}
          value={fadedPercent}
          onChange={(value) => update({ fadedOpacity: value / 100 })}
          label="Faded connections opacity"
          readout={`${fadedPercent}%`}
        />
      </DialogRow>

      <DialogRow title="Gradient" description="Fade the middle of each connection so the ends stay readable" className="py-3">
        <Switch label="Gradient" checked={appearance.gradient} onChange={(gradient) => update({ gradient })} />
      </DialogRow>

      <DialogRow title="Loading pulse" description="Animate connections into a node while it generates" className="py-3">
        <Switch label="Loading pulse" checked={appearance.loadingPulse} onChange={(loadingPulse) => update({ loadingPulse })} />
      </DialogRow>

      <div className="flex items-center justify-between gap-4 pt-3 border-t border-card">
        <DialogEyebrow className="text-neutral-500">
          {defaultSaved ? "Saved as your default for new workflows" : "Saved with this workflow"}
        </DialogEyebrow>
        <DialogTextButton onClick={onSetDefault}>Set as my default</DialogTextButton>
      </div>
    </div>
  );
}
