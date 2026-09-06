"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ProviderType, ModelInputDef } from "@/types";
import { ModelParameter } from "@/lib/providers/types";
import { useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { CheckboxField, FieldList, NumberField, SelectField, TextField } from "./ui/Field";

// localStorage cache for model schemas (persists across dev server restarts)
const SCHEMA_CACHE_KEY = "node-banana-schema-cache";
const SCHEMA_CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours

interface SchemaCacheEntry {
  parameters: ModelParameter[];
  inputs: ModelInputDef[];
  timestamp: number;
}

function getCachedSchema(modelId: string, provider: string): SchemaCacheEntry | null {
  try {
    const cache = JSON.parse(localStorage.getItem(SCHEMA_CACHE_KEY) || "{}");
    const key = `${provider}:${modelId}`;
    const entry = cache[key];
    if (entry && Date.now() - entry.timestamp < SCHEMA_CACHE_TTL) {
      return entry;
    }
  } catch {
    // Ignore cache errors
  }
  return null;
}

function setCachedSchema(modelId: string, provider: string, parameters: ModelParameter[], inputs: ModelInputDef[]) {
  try {
    const cache = JSON.parse(localStorage.getItem(SCHEMA_CACHE_KEY) || "{}");
    cache[`${provider}:${modelId}`] = { parameters, inputs, timestamp: Date.now() };
    localStorage.setItem(SCHEMA_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore cache errors
  }
}

interface ModelParametersProps {
  modelId: string;
  provider: ProviderType;
  parameters: Record<string, unknown>;
  onParametersChange: (parameters: Record<string, unknown>) => void;
  onExpandChange?: (expanded: boolean, parameterCount: number) => void;
  onInputsLoaded?: (inputs: ModelInputDef[]) => void;
}

/**
 * Collapsible parameter inputs for external provider models.
 * Fetches schema from /api/models/{modelId}?provider={provider}
 * and renders appropriate inputs based on parameter types.
 */
function ModelParametersInner({
  modelId,
  provider,
  parameters,
  onParametersChange,
  onExpandChange,
  onInputsLoaded,
}: ModelParametersProps) {
  const [schema, setSchema] = useState<ModelParameter[]>([]);
  // Tracks which `${provider}:${modelId}` the current `schema` belongs to.
  // Prevents the defaults effect from writing a previous model's defaults into
  // freshly-cleared parameters during the render where modelId changes but the
  // async schema fetch hasn't updated `schema` yet.
  const [schemaKey, setSchemaKey] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey } = useProviderApiKeys();

  // Fetch schema when modelId changes
  useEffect(() => {
    if (!modelId) {
      setSchema([]);
      setSchemaKey("");
      onInputsLoaded?.([]);
      return;
    }

    const currentKey = `${provider}:${modelId}`;
    // Staleness guard: if modelId/provider changes before this async flow
    // resolves, an older in-flight request must not overwrite the newer
    // model's schema/inputs. Cleanup sets `cancelled = true` on the stale run.
    let cancelled = false;

    const fetchSchema = async () => {
      // Check localStorage cache first
      const cached = getCachedSchema(modelId, provider);
      if (cached) {
        if (cancelled) return;
        setSchema(cached.parameters);
        setSchemaKey(currentKey);
        onInputsLoaded?.(cached.inputs);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const headers: HeadersInit = {};
        if (replicateApiKey) {
          headers["X-Replicate-Key"] = replicateApiKey;
        }
        if (falApiKey) {
          headers["X-Fal-Key"] = falApiKey;
        }
        if (kieApiKey) {
          headers["X-Kie-Key"] = kieApiKey;
        }
        if (wavespeedApiKey) {
          headers["X-WaveSpeed-Key"] = wavespeedApiKey;
        }

        const encodedModelId = encodeURIComponent(modelId);
        const response = await deduplicatedFetch(
          `/api/models/${encodedModelId}?provider=${provider}`,
          { headers }
        );

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to fetch schema: ${response.status}`);
        }

        const data = await response.json();
        const params = data.parameters || [];
        const inputs = data.inputs || [];

        // Cache the successful result (safe regardless of staleness).
        setCachedSchema(modelId, provider, params, inputs);

        if (cancelled) return;
        setSchema(params);
        setSchemaKey(currentKey);

        // Pass inputs to parent for dynamic handle rendering
        if (onInputsLoaded) {
          onInputsLoaded(inputs);
        }
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to fetch model schema:", err);
        setError(err instanceof Error ? err.message : "Failed to fetch schema");
        setSchema([]);
        setSchemaKey(currentKey);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchSchema();

    return () => {
      cancelled = true;
    };
  }, [modelId, provider, replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey, onInputsLoaded]);

  // Pre-populate schema defaults into parameters
  useEffect(() => {
    // Guard: only apply defaults when `schema` belongs to the currently
    // selected model. On model switch the parent clears `parameters` to {}
    // synchronously, but `schema` (fetched async) still holds the previous
    // model's schema for one render — applying it here would write the old
    // model's defaults back into the new model's parameters.
    if (schemaKey !== `${provider}:${modelId}`) return;
    if (schema.length === 0) return;
    const defaults: Record<string, unknown> = {};
    let hasNewDefaults = false;
    for (const param of schema) {
      if (param.default !== undefined && parameters[param.name] === undefined) {
        defaults[param.name] = param.default;
        hasNewDefaults = true;
      }
    }
    if (hasNewDefaults) {
      onParametersChange({ ...parameters, ...defaults });
    }
  }, [schema, schemaKey, modelId, provider, parameters, onParametersChange]);

  // Notify parent to resize node when schema loads
  useEffect(() => {
    if (schema.length > 0 && onExpandChange) {
      onExpandChange(true, schema.length);
    }
  }, [schema, onExpandChange]);

  const handleParameterChange = useCallback(
    (name: string, value: unknown) => {
      // Create new parameters object with updated value
      const newParams = { ...parameters };

      // If value is empty/undefined, remove the parameter
      if (value === "" || value === undefined || value === null) {
        delete newParams[name];
      } else {
        newParams[name] = value;
      }

      onParametersChange(newParams);
    },
    [parameters, onParametersChange]
  );

  const sortedSchema = useMemo(() => {
    return [...schema].sort((a, b) => {
      // Sort order: dropdowns first, then numbers, then strings, then checkboxes last
      const typeOrder = (p: ModelParameter) => {
        if (p.enum && p.enum.length > 0) return 0; // dropdowns first
        if (p.type === "number" || p.type === "integer") return 1;
        if (p.type === "boolean") return 3; // checkboxes last
        return 2; // string and other
      };
      return typeOrder(a) - typeOrder(b);
    });
  }, [schema]);

  // Don't render if no model selected
  if (!modelId) {
    return null;
  }

  // Don't render if no schema available and not loading
  if (!isLoading && schema.length === 0 && !error) {
    return null;
  }

  return (
    <div className="shrink-0">
      {error ? (
        <span className="text-[9px] text-red-400">{error}</span>
      ) : isLoading ? (
        <span className="text-[9px] text-neutral-500">Loading parameters...</span>
      ) : schema.length === 0 ? (
        <span className="text-[9px] text-neutral-500">No parameters available</span>
      ) : (
        <FieldList>
          {sortedSchema.map((param) => (
            <ParameterInput
              key={param.name}
              param={param}
              name={param.name}
              value={parameters[param.name]}
              onChange={handleParameterChange}
            />
          ))}
        </FieldList>
      )}
    </div>
  );
}

interface ParameterInputProps {
  param: ModelParameter;
  name: string;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}

/**
 * One parameter, as the field its type calls for. Text and number fields
 * keep local state while focused (see Field.tsx) so React Flow re-renders
 * never move the caret.
 */
function ParameterInputInner({ param, name, value, onChange }: ParameterInputProps) {
  const handleChange = useCallback((value: unknown) => {
    onChange(name, value);
  }, [name, onChange]);
  const displayName = param.name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const description = param.description || undefined;

  if (param.enum && param.enum.length > 0) {
    return (
      <SelectField
        label={displayName}
        hint={description}
        value={value === undefined || value === null ? "" : String(value)}
        options={param.enum.map((opt) => String(opt))}
        emptyLabel="Default"
        onChange={(val) => {
          if (val === "") handleChange(undefined);
          else if (param.type === "integer") handleChange(parseInt(val, 10));
          else if (param.type === "number") handleChange(parseFloat(val));
          else if (param.type === "boolean") handleChange(val === "true");
          else handleChange(val);
        }}
      />
    );
  }

  if (param.type === "boolean") {
    const effectiveValue = value !== undefined ? Boolean(value) : Boolean(param.default);
    return <CheckboxField label={displayName} hint={description} checked={effectiveValue} onChange={handleChange} />;
  }

  if (param.type === "number" || param.type === "integer") {
    const hasRange = param.minimum !== undefined && param.maximum !== undefined;
    const hint = hasRange
      ? `${description ? `${description} ` : ""}(${param.minimum}-${param.maximum})`
      : description;
    return (
      <NumberField
        label={displayName}
        hint={hint}
        value={typeof value === "number" ? value : value === undefined || value === null ? undefined : Number(value)}
        min={param.minimum}
        max={param.maximum}
        integer={param.type === "integer"}
        placeholder={param.default !== undefined ? `${param.default}` : undefined}
        onChange={handleChange}
      />
    );
  }

  // Skip array type for now (complex)
  if (param.type === "array") {
    return null;
  }

  return (
    <TextField
      label={displayName}
      hint={description}
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={param.default !== undefined ? `${param.default}` : undefined}
      onChange={handleChange}
    />
  );
}

// Memoized exports to prevent unnecessary re-renders
export const ModelParameters = React.memo(ModelParametersInner);
const ParameterInput = React.memo(ParameterInputInner);
