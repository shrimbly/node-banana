"use client";

import React, { useCallback, useMemo } from "react";

import { ComfyCurveEditor } from "./ComfyCurveEditor";
import type { ComfyAppParam } from "@/lib/comfy/types";
import { CheckboxField, FieldList, FieldRow, NumberField, SelectField, TextField, TextareaField } from "./ui/Field";

interface ComfyAppParametersProps {
  params: ComfyAppParam[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}

/**
 * `Sampler Steps` from `KSampler · sampler_steps`.
 *
 * The node name is noise for an ordinary widget — every setting on a KSampler
 * would repeat it. For a curve it is the opposite: `Red · Curve` and
 * `Green · Curve` are told apart by exactly the part being dropped, so those
 * keep their full label.
 */
function shortLabel(param: ComfyAppParam): string {
  if (param.type === "curve") return param.label;
  const tail = param.label.split("·").pop()?.trim();
  return tail && tail.length > 0 ? tail : param.label;
}

/**
 * Inline controls for a Comfy app's exposed widgets.
 *
 * These come from the workflow itself — App Mode selections when the author
 * curated them, otherwise the widgets the user opted into at import — so the
 * shape is only known at run time. Rendering mirrors {@link ModelParameters}
 * so a Comfy node's settings look like every other generation node's.
 */
function ComfyAppParametersInner({ params, values, onChange }: ComfyAppParametersProps) {
  const handleChange = useCallback(
    (id: string, value: unknown) => {
      const next = { ...values };
      if (value === "" || value === undefined || value === null) delete next[id];
      else next[id] = value;
      onChange(next);
    },
    [values, onChange]
  );

  // Dropdowns first, then numbers, strings, and checkboxes last — the same
  // ordering the model parameter panel uses, so the two read alike.
  const sorted = useMemo(() => {
    const weight = (param: ComfyAppParam): number => {
      if (param.enum && param.enum.length > 0) return 0;
      if (param.type === "number" || param.type === "integer") return 1;
      if (param.type === "boolean") return 3;
      return 2;
    };
    return [...params].sort((a, b) => weight(a) - weight(b));
  }, [params]);

  if (params.length === 0) {
    return <span className="text-[9px] text-neutral-500">This workflow exposes no settings</span>;
  }

  return (
    <FieldList className="shrink-0">
      {sorted.map((param) => (
        <ComfyParameterInput
          key={param.id}
          param={param}
          value={values[param.id]}
          onChange={handleChange}
        />
      ))}
    </FieldList>
  );
}

interface ComfyParameterInputProps {
  param: ComfyAppParam;
  value: unknown;
  onChange: (id: string, value: unknown) => void;
}

/** One widget control, as the field its type calls for. */
function ComfyParameterInputInner({ param, value, onChange }: ComfyParameterInputProps) {
  const label = shortLabel(param);
  const description = param.description;

  if (param.type === "curve") {
    return (
      <FieldRow className="h-auto">
        <div className="w-full">
          <ComfyCurveEditor
            label={label}
            value={value ?? param.default}
            onChange={(curve) => onChange(param.id, curve)}
            {...(description ? { description } : {})}
          />
        </div>
      </FieldRow>
    );
  }

  if (param.enum && param.enum.length > 0) {
    return (
      <SelectField
        label={label}
        hint={description}
        value={value === undefined || value === null ? "" : String(value)}
        options={param.enum}
        emptyLabel={param.default !== undefined ? `Default (${String(param.default)})` : "Default"}
        onChange={(val) => onChange(param.id, val || undefined)}
      />
    );
  }

  if (param.type === "boolean") {
    const checked = value !== undefined ? Boolean(value) : Boolean(param.default);
    return <CheckboxField label={label} hint={description} checked={checked} onChange={(next) => onChange(param.id, next)} />;
  }

  if (param.multiline) {
    return (
      <TextareaField
        label={label}
        hint={description}
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={param.default !== undefined ? String(param.default) : undefined}
        onChange={(text) => onChange(param.id, text)}
      />
    );
  }

  const isNumber = param.type === "number" || param.type === "integer";
  const randomise = param.isSeed ? (
    <button
      type="button"
      title="Randomise this seed now"
      onClick={() => onChange(param.id, Math.floor(Math.random() * 1_000_000_000))}
      className="nodrag nopan shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-well squircle text-neutral-500 hover:text-neutral-200 hover:bg-white/5 transition-colors"
    >
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 2v6h-6" />
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M3 22v-6h6" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      </svg>
    </button>
  ) : undefined;

  if (isNumber) {
    return (
      <NumberField
        label={label}
        hint={description}
        value={typeof value === "number" ? value : value === undefined || value === null ? undefined : Number(value)}
        min={param.minimum}
        max={param.maximum}
        integer={param.type === "integer"}
        placeholder={param.default !== undefined ? String(param.default) : undefined}
        onChange={(next) => onChange(param.id, next)}
        trailing={randomise}
      />
    );
  }

  return (
    <TextField
      label={label}
      hint={description}
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={param.default !== undefined ? String(param.default) : undefined}
      onChange={(text) => onChange(param.id, text)}
      trailing={randomise}
    />
  );
}

const ComfyParameterInput = React.memo(ComfyParameterInputInner);
export const ComfyAppParameters = React.memo(ComfyAppParametersInner);
