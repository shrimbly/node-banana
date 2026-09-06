"use client";

import { EdgeAppearance, EdgeStyle, EdgeThickness } from "@/types";
import { EDGE_THICKNESS_PX } from "@/lib/edges/appearance";
import { HANDLE_TYPE_COLORS } from "@/lib/edges/colors";
import { gradientOpacities } from "@/components/edges/SharedEdgeGradients";

/**
 * The "Connections" section of the Canvas settings tab: how noodles are
 * drawn. Draft state lives in the modal; this component only renders and
 * reports changes.
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

function Segmented<T extends string>({
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
    <div className="flex gap-1 p-0.5 bg-neutral-800 rounded-md w-[232px] shrink-0" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`flex-1 px-2 py-1.5 text-xs rounded transition-all duration-150 ${
            value === option.value
              ? "bg-neutral-700 text-neutral-100 font-medium"
              : "text-neutral-400 hover:text-neutral-300"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm text-neutral-200">{label}</span>
        {hint && <span className="text-xs text-neutral-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-neutral-600"}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
    </button>
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
      className="h-16 rounded-md border border-neutral-700/60 overflow-hidden"
      style={{ backgroundColor: "#171717", backgroundImage: "radial-gradient(#404040 1px, transparent 1px)", backgroundSize: "20px 20px" }}
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
    <>
      <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-neutral-100">Connections</span>
            <p className="text-xs text-neutral-400">How the noodles between nodes are drawn</p>
          </div>

          <ConnectionPreview edgeStyle={edgeStyle} appearance={appearance} />

          <SettingRow label="Line style" hint="Also toggled from the action bar">
            <Segmented label="Line style" options={LINE_STYLES} value={edgeStyle} onChange={onEdgeStyleChange} />
          </SettingRow>

          <SettingRow label="Thickness" hint="Regular is 3px">
            <Segmented
              label="Thickness"
              options={THICKNESSES}
              value={appearance.thickness}
              onChange={(thickness) => update({ thickness })}
            />
          </SettingRow>

          <SettingRow label="Faded connections" hint="Opacity when not attached to a selected node">
            <div className="flex items-center gap-2.5 w-[232px] shrink-0 px-0.5">
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={fadedPercent}
                onChange={(e) => update({ fadedOpacity: Number(e.target.value) / 100 })}
                aria-label="Faded connections opacity"
                className="flex-1 accent-neutral-300"
              />
              <span className="w-8 text-right text-xs text-neutral-300 tabular-nums">{fadedPercent}%</span>
            </div>
          </SettingRow>

          <div className="flex items-center justify-between pt-2.5 border-t border-neutral-700">
            <span className="text-xs text-neutral-500">
              {defaultSaved ? "Saved as your default for new workflows." : "Saved with this workflow."}
            </span>
            <button
              type="button"
              onClick={onSetDefault}
              className="px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Set as my default
            </button>
          </div>
        </div>
      </div>

      <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-sm text-neutral-200">Gradient</span>
            <p className="text-xs text-neutral-400">Fade the middle of each connection so the ends stay readable</p>
          </div>
          <Switch label="Gradient" checked={appearance.gradient} onChange={(gradient) => update({ gradient })} />
        </div>
        <div className="flex items-center justify-between gap-3 pt-2 mt-2 border-t border-neutral-700">
          <div>
            <span className="text-sm text-neutral-200">Loading pulse</span>
            <p className="text-xs text-neutral-400">Animate connections into a node while it generates</p>
          </div>
          <Switch label="Loading pulse" checked={appearance.loadingPulse} onChange={(loadingPulse) => update({ loadingPulse })} />
        </div>
      </div>
    </>
  );
}
