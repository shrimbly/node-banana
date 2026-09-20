"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

import { cn } from "@/components/nodes/ui/cn";

/**
 * Form controls for the split dialogs: the input well, a labelled field,
 * an ink segmented control, an ink switch and the range slider. All of
 * them are the canvas's "C · Split" drawings, so a settings page is
 * assembled rather than styled.
 */

/** Text input: 36px, #262626 well, hairline border, 8px corners. */
export const inputClass =
  "h-9 w-full px-3 rounded-lg border border-card-border bg-card text-[13px] text-neutral-100 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-500 focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-50";

/** Field label: 12px medium, neutral-400. */
export const labelClass = "block text-xs leading-4 font-medium text-neutral-400 mb-1.5";

/** Small print under a field. */
export const helpClass = "mt-1.5 text-xs leading-4 text-neutral-500";

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(inputClass, className)} />;
}

export function Field({
  id,
  label,
  help,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
      {help && <p className={helpClass}>{help}</p>}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** Ink segmented control on a #262626 track. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  disabled,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex gap-0.5 p-0.5 rounded-lg bg-card", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.title}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex-1 h-7 px-2 rounded-md font-display text-xs tracking-[-0.01em] whitespace-nowrap transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
              "disabled:opacity-50 disabled:cursor-not-allowed",
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

/** Ink switch: 40×22, knob in the canvas colour. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name, or label the switch with `aria-labelledby` via `id`. */
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-bg",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-neutral-200" : "bg-neutral-600",
        className
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full transition-transform",
          checked ? "translate-x-[21px] bg-canvas-bg" : "translate-x-[3px] bg-neutral-200"
        )}
      />
    </button>
  );
}

/** Range slider with an ink fill and a mono readout. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  readout,
  className,
  disabled,
  id,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  /** Text to the right of the track; defaults to the value. */
  readout?: ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        className="range-ink flex-1 min-w-0 disabled:opacity-50"
        style={{ "--p": `${pct}%` } as React.CSSProperties}
      />
      <span className="w-11 text-right font-mono text-[11px] text-neutral-400 tabular-nums">{readout ?? value}</span>
    </div>
  );
}

/** Native select in the input well, with its own chevron. */
export function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn("relative", className)}>
      <select {...rest} className={cn(inputClass, "appearance-none pr-8")}>
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-2.5 w-4 h-4 text-neutral-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  );
}
