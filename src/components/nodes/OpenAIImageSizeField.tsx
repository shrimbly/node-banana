"use client";

import { useNodeId } from "@xyflow/react";
import { OPENAI_IMAGE_SIZE_PRESETS, validateOpenAIImageSize } from "@/lib/providers/openaiImages";
import { NumberField, SelectField } from "./ui/Field";
import { useNodeUiState } from "./paintMode";

export function OpenAIImageSizeField({ value, onChange, scope = "" }: {
  value: string;
  onChange: (size: string) => void;
  /**
   * The model block and model this field sizes. On classic the field mounts
   * afresh for each (a tab switch, a model change), starting at the presets;
   * on the GPU canvas its view state is kept under this, to the same effect.
   */
  scope?: string;
}) {
  // "Custom…" chosen with a preset still set: node view state, so a painted
  // copy on the GPU canvas keeps showing Width and Height (useNodeUiState).
  const nodeId = useNodeId();
  const [customSelected, setCustomSelected] = useNodeUiState(nodeId ?? "", "openaiSizeCustom", false, scope);
  const custom = customSelected || !OPENAI_IMAGE_SIZE_PRESETS.includes(value);
  const [width, height] = value.split("x").map(Number);
  const error = validateOpenAIImageSize(value);
  const experimental = !error && width * height > 2560 * 1440;

  return <>
    <SelectField
      label="Size"
      value={custom ? "custom" : value}
      options={[
        ...OPENAI_IMAGE_SIZE_PRESETS.map(size => ({
          value: size,
          label: size === "auto" ? "Auto" : `${size.replace("x", " × ")}${Number(size.split("x")[0]) * Number(size.split("x")[1]) > 2560 * 1440 ? " (experimental)" : ""}`,
        })),
        { value: "custom", label: "Custom…" },
      ]}
      onChange={size => {
        setCustomSelected(size === "custom");
        onChange(size === "custom" ? (value === "auto" ? "1536x864" : value) : size);
      }}
    />
    {custom && <>
      <NumberField label="Width" value={width || undefined} min={16} max={3840} step={16} integer unit="px" allowEmpty={false}
        onChange={next => onChange(`${next ?? width}x${height || 864}`)} />
      <NumberField label="Height" value={height || undefined} min={16} max={3840} step={16} integer unit="px" allowEmpty={false}
        onChange={next => onChange(`${width || 1536}x${next ?? height}`)} />
    </>}
    {error && <p role="alert" className="text-node text-red-400">{error}</p>}
    {experimental && <p className="text-node text-neutral-400">This output size is experimental.</p>}
  </>;
}
