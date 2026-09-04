"use client";

import React, { ReactNode, useCallback, useEffect, useId, useState } from "react";
import { cn } from "./cn";

/**
 * Settings-panel fields. One column, tight density: a 22px row with a 72px
 * label on the left and a dark well on the right.
 *
 * Text and number inputs keep a local copy of their value while focused so
 * React Flow re-renders (which happen on every store write) never move the
 * caret; the store is written on blur or Enter.
 */

/** The dark well every input sits in. */
export const wellClass =
  "nodrag nopan block h-[22px] w-full min-w-0 px-[7px] rounded-well squircle bg-well shadow-well " +
  "text-node text-neutral-200 placeholder:text-neutral-500 " +
  "focus:outline-none focus:ring-1 focus:ring-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed";

/** Optical centring for single-line text: trims the leading above cap height and below the baseline. */
export const trimClass = "leading-none [text-box:trim-both_cap_alphabetic]";

/** Single-line ellipsis that does not clip descenders. */
export const ellipsisClass =
  "whitespace-nowrap text-ellipsis overflow-clip [overflow-clip-margin:4px]";

export interface FieldProps {
  label: string;
  /** Tooltip on the label. */
  hint?: string;
  htmlFor?: string;
  /** Let the row grow (textarea, curve editors). */
  tall?: boolean;
  className?: string;
  children: ReactNode;
  "data-tutorial"?: string;
}

export function Field({ label, hint, htmlFor, tall, className, children, ...rest }: FieldProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-[72px_minmax(0,1fr)] gap-x-2",
        tall ? "items-start" : "items-center h-[22px]",
        className
      )}
      data-tutorial={rest["data-tutorial"]}
    >
      <label
        htmlFor={htmlFor}
        title={hint}
        className={cn("text-node text-neutral-400 min-w-0", ellipsisClass, tall && "pt-[5px]")}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/** A full-width row without a label column (buttons, chips, editors). */
export function FieldRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("min-h-[22px] flex items-center gap-1", className)}>{children}</div>;
}

/** Stacks fields with the panel's 4px gap. */
export function FieldList({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-col gap-1", className)}>{children}</div>;
}

/** Stable id for label association when the caller passes none. */
function useFieldId(id?: string): string {
  const generated = useId();
  return id ?? `field-${generated}`;
}

/* ------------------------------------------------------------------ select */

export type SelectOption = { value: string; label: string; disabled?: boolean };

export interface SelectFieldProps {
  label: string;
  hint?: string;
  value: string;
  options: ReadonlyArray<SelectOption | string>;
  onChange: (value: string) => void;
  /** Adds a leading option with this label and an empty value. */
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  "data-tutorial"?: string;
}

export function SelectField({
  label,
  hint,
  value,
  options,
  onChange,
  emptyLabel,
  disabled,
  id: idProp,
  ...rest
}: SelectFieldProps) {
  const id = useFieldId(idProp);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <SelectWell
        id={id}
        value={value}
        options={options}
        onChange={onChange}
        emptyLabel={emptyLabel}
        disabled={disabled}
        data-tutorial={rest["data-tutorial"]}
      />
    </Field>
  );
}

/** The select well on its own, for rows that lay out several. */
export function SelectWell({
  id,
  value,
  options,
  onChange,
  emptyLabel,
  disabled,
  className,
  ...rest
}: Omit<SelectFieldProps, "label" | "hint"> & { className?: string }) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-tutorial={rest["data-tutorial"]}
        className={cn(wellClass, "appearance-none pr-5 cursor-pointer")}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {options.map((opt) => {
          const o = typeof opt === "string" ? { value: opt, label: opt } : opt;
          return (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          );
        })}
      </select>
      <svg
        className="pointer-events-none absolute right-[6px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-neutral-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------- local edit state */

/**
 * Local text state that follows `value` from the store except while the
 * input has focus. Returns the text, a setter, and focus/blur handlers.
 */
export function useLocalEdit(value: string | number | null | undefined) {
  const toText = (v: typeof value) => (v === undefined || v === null ? "" : String(v));
  const [text, setText] = useState<string>(() => toText(value));
  const [focused, setFocused] = useState(false);

  // Follow the store whenever the input is not being edited, including the
  // moment focus leaves it.
  useEffect(() => {
    if (!focused) setText(toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);

  return { text, setText, onFocus, onBlur, focused };
}

/* ------------------------------------------------------------------ number */

export interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number | undefined | null;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  placeholder?: string;
  /** Short unit shown inside the well's right edge ("px", "%", "s"). */
  unit?: string;
  disabled?: boolean;
  id?: string;
  /** Sends `undefined` when the well is cleared (default) or keeps the last value. */
  allowEmpty?: boolean;
  /** Rendered after the well (a randomise button, say). */
  trailing?: ReactNode;
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  integer,
  placeholder,
  unit,
  disabled,
  id: idProp,
  allowEmpty = true,
  trailing,
}: NumberFieldProps) {
  const id = useFieldId(idProp);
  const { text, setText, onFocus, onBlur } = useLocalEdit(value);

  let validation: string | null = null;
  if (text !== "" && !Number.isNaN(Number(text))) {
    const n = Number(text);
    if (min !== undefined && n < min) validation = `Min: ${min}`;
    else if (max !== undefined && n > max) validation = `Max: ${max}`;
    else if (integer && !Number.isInteger(n)) validation = "Must be integer";
  }

  const commit = () => {
    if (text === "") {
      if (allowEmpty) onChange(undefined);
      else setText(value === undefined || value === null ? "" : String(value));
      return;
    }
    const n = integer ? parseInt(text, 10) : parseFloat(text);
    if (Number.isNaN(n)) {
      onChange(undefined);
      return;
    }
    let clamped = n;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    onChange(clamped);
    if (clamped !== n) setText(String(clamped));
  };

  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-1 min-w-0">
      <div className="relative min-w-0 flex-1">
        <input
          id={id}
          type="number"
          value={text}
          min={min}
          max={max}
          step={step ?? (integer ? 1 : 0.1)}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={onFocus}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            onBlur();
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          title={validation ?? undefined}
          className={cn(
            wellClass,
            "tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
            (unit || validation) && "pr-6",
            validation && "ring-1 ring-red-500"
          )}
        />
        {validation ? (
          <span className="pointer-events-none absolute right-[7px] top-1/2 -translate-y-1/2 text-[9px] text-red-400 whitespace-nowrap">
            {validation}
          </span>
        ) : unit ? (
          <span className="pointer-events-none absolute right-[7px] top-1/2 -translate-y-1/2 text-node text-neutral-500">
            {unit}
          </span>
        ) : null}
      </div>
      {trailing}
      </div>
    </Field>
  );
}

/* -------------------------------------------------------------------- text */

export interface TextFieldProps {
  label: string;
  hint?: string;
  value: string | undefined | null;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  trailing?: ReactNode;
}

export function TextField({ label, hint, value, onChange, placeholder, disabled, id: idProp, trailing }: TextFieldProps) {
  const id = useFieldId(idProp);
  const { text, setText, onFocus, onBlur } = useLocalEdit(value);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-1 min-w-0">
      <input
        id={id}
        type="text"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={onFocus}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          onBlur();
          onChange(text || undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={cn(wellClass, "flex-1")}
      />
      {trailing}
      </div>
    </Field>
  );
}

/* ---------------------------------------------------------------- textarea */

export interface TextareaFieldProps {
  label: string;
  hint?: string;
  value: string | undefined | null;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  id?: string;
}

export function TextareaField({ label, hint, value, onChange, placeholder, rows = 3, disabled, id: idProp }: TextareaFieldProps) {
  const id = useFieldId(idProp);
  const { text, setText, onFocus, onBlur } = useLocalEdit(value);
  return (
    <Field label={label} hint={hint} htmlFor={id} tall>
      <textarea
        id={id}
        value={text}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={onFocus}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          onBlur();
          onChange(text || undefined);
        }}
        className={cn(wellClass, "nowheel h-auto py-1 resize-none leading-[14px]")}
      />
    </Field>
  );
}

/* ------------------------------------------------------------------- range */

export interface RangeFieldProps {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Formats the readout; defaults to the raw number. */
  format?: (value: number) => string;
  disabled?: boolean;
  id?: string;
}

export function RangeField({ label, hint, value, onChange, min, max, step = 1, format, disabled, id: idProp }: RangeFieldProps) {
  const id = useFieldId(idProp);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="grid grid-cols-[minmax(0,1fr)_36px] items-center gap-2 h-[22px]">
        <input
          id={id}
          type="range"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="nodrag nopan w-full h-1 accent-neutral-300 cursor-pointer disabled:opacity-50"
        />
        <span className="text-node text-neutral-300 tabular-nums text-right">
          {format ? format(value) : value}
        </span>
      </div>
    </Field>
  );
}

/* ---------------------------------------------------------------- checkbox */

export interface CheckboxFieldProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}

export function CheckboxField({ label, hint, checked, onChange, disabled, id: idProp }: CheckboxFieldProps) {
  const id = useFieldId(idProp);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center h-[22px]">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="nodrag nopan w-3 h-3 accent-neutral-300 cursor-pointer disabled:opacity-50"
        />
      </div>
    </Field>
  );
}

/* ------------------------------------------------------------------- chips */

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

/** A row of mutually exclusive chips inside a well (mode pickers). */
export function ChipGroup<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: T;
  options: ReadonlyArray<ChipOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "nodrag nopan flex items-center h-[22px] p-[2px] gap-[2px] rounded-well squircle bg-well shadow-well",
        className
      )}
      role="radiogroup"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 min-w-0 h-full px-1.5 rounded-[6px] squircle text-node transition-colors",
              ellipsisClass,
              active ? "bg-neutral-600 text-white" : "text-neutral-400 hover:text-neutral-200",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ button */

export function PanelButton({
  className,
  primary,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "nodrag nopan h-[22px] px-2.5 rounded-well squircle text-node font-medium transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        primary
          ? "bg-blue-600 text-white hover:bg-blue-500"
          : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600",
        className
      )}
    />
  );
}
