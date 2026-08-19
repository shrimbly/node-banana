"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ProviderType, ModelInputDef } from "@/types";
import { ModelParameter } from "@/lib/providers/types";
import { useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";

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

/** Reorder items so they read column-first in a row-based CSS grid.
 *  e.g. [1,2,3,4,5,6,7,8] with 2 cols → [1,5,2,6,3,7,4,8] */
function reorderColumnFirst<T>(items: T[], cols: number): T[] {
  const rows = Math.ceil(items.length / cols);
  const result: T[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = c * rows + r;
      if (idx < items.length) result.push(items[idx]);
    }
  }
  return result;
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
  const { replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey, metasoApiKey } = useProviderApiKeys();

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
        if (metasoApiKey) {
          headers["X-Metaso-API-Key"] = metasoApiKey;
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
  }, [modelId, provider, replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey, metasoApiKey, onInputsLoaded]);

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

  const useGrid = sortedSchema.length > 4;
  const gridRef = useRef<HTMLDivElement>(null);
  const [colCount, setColCount] = useState(1);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || !useGrid) { setColCount(1); return; }
    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const cols = getComputedStyle(el).gridTemplateColumns.split(" ").length;
        setColCount(prev => prev === cols ? prev : cols);
      });
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [useGrid]);

  const displaySchema = useMemo(() => {
    return useGrid && colCount > 1
      ? reorderColumnFirst(sortedSchema, colCount)
      : sortedSchema;
  }, [sortedSchema, useGrid, colCount]);

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
        <div
          ref={gridRef}
          className={useGrid
            ? "grid grid-cols-[repeat(auto-fill,minmax(min(180px,100%),1fr))] max-w-[420px] gap-x-6 gap-y-1.5"
            : "space-y-1.5 max-w-[280px]"
          }
        >
          {displaySchema.map((param) => (
            <ParameterInput
              key={param.name}
              param={param}
              name={param.name}
              value={parameters[param.name]}
              onChange={handleParameterChange}
            />
          ))}
        </div>
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
 * Individual parameter input based on type.
 * Text and number inputs use local state during editing to prevent
 * cursor-jump issues caused by React Flow re-renders on store updates.
 */
function ParameterInputInner({ param, name, value, onChange }: ParameterInputProps) {
  // Stable callback that passes name along with value
  const handleChange = useCallback((value: unknown) => {
    onChange(name, value);
  }, [name, onChange]);
  const displayName = param.name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // Local state for text/number inputs to prevent cursor jumping
  const [localValue, setLocalValue] = useState<string>(() => {
    if (value === undefined || value === null) return "";
    return String(value);
  });
  const isFocusedRef = useRef(false);

  // Sync from store when not focused (external changes)
  useEffect(() => {
    if (!isFocusedRef.current) {
      setLocalValue(value === undefined || value === null ? "" : String(value));
    }
  }, [value]);

  // Determine input type and render accordingly
  if (param.enum && param.enum.length > 0) {
    // Enum: render as select
    return (
      <div className="flex items-center gap-2">
        <label
          className="text-[11px] text-neutral-400 shrink-0"
          title={param.description || undefined}
        >
          {displayName}
        </label>
        <select
          value={(value as string) ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") {
              handleChange(undefined);
            } else if (param.type === "integer") {
              handleChange(parseInt(val, 10));
            } else if (param.type === "number") {
              handleChange(parseFloat(val));
            } else if (param.type === "boolean") {
              handleChange(val === "true");
            } else {
              handleChange(val);
            }
          }}
          className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 rounded-md bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white"
        >
          <option value="">Default</option>
          {param.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (param.type === "boolean") {
    // Use schema default when value not explicitly set
    const effectiveValue = value !== undefined ? Boolean(value) : Boolean(param.default);

    // Boolean: render as checkbox
    return (
      <label
        className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer"
        title={param.description || undefined}
      >
        <input
          type="checkbox"
          checked={effectiveValue}
          onChange={(e) => handleChange(e.target.checked)}
          className="nodrag nopan w-3 h-3 rounded bg-[#1a1a1a] text-neutral-600 focus:ring-1 focus:ring-neutral-600 focus:ring-offset-0"
        />
        <span>{displayName}</span>
      </label>
    );
  }

  if (param.type === "number" || param.type === "integer") {
    const hasMin = param.minimum !== undefined;
    const hasMax = param.maximum !== undefined;

    // Validate current value against constraints
    let validationError: string | null = null;
    if (localValue !== "" && !isNaN(Number(localValue))) {
      const num = Number(localValue);
      if (hasMin && num < param.minimum!) {
        validationError = `Min: ${param.minimum}`;
      } else if (hasMax && num > param.maximum!) {
        validationError = `Max: ${param.maximum}`;
      } else if (param.type === "integer" && !Number.isInteger(num)) {
        validationError = "Must be integer";
      }
    }

    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <label
            className="text-[11px] text-neutral-400 shrink-0 flex items-center gap-1"
            title={param.description || undefined}
          >
            {displayName}
            {hasMin && hasMax && (
              <span className="text-neutral-500 text-[9px]">
                ({param.minimum}-{param.maximum})
              </span>
            )}
          </label>
          <input
            type="number"
            value={localValue}
            min={param.minimum}
            max={param.maximum}
            step={param.type === "integer" ? 1 : 0.1}
            onFocus={() => { isFocusedRef.current = true; }}
            onChange={(e) => {
              setLocalValue(e.target.value);
            }}
            onBlur={() => {
              isFocusedRef.current = false;
              if (localValue === "") {
                handleChange(undefined);
              } else {
                const num = param.type === "integer" ? parseInt(localValue, 10) : parseFloat(localValue);
                handleChange(isNaN(num) ? undefined : num);
              }
            }}
            placeholder={param.default !== undefined ? `${param.default}` : undefined}
            className={`nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 rounded-md bg-[#1a1a1a] focus:outline-none focus:ring-1 text-white placeholder:text-neutral-500 ${
              validationError
                ? "ring-1 ring-red-500"
                : "focus:ring-neutral-600"
            }`}
          />
        </div>
        {validationError && (
          <span className="text-[9px] text-red-400">{validationError}</span>
        )}
      </div>
    );
  }

  // Skip array type for now (complex)
  if (param.type === "array") {
    return null;
  }

  // Default: string input — uses local state, syncs to store on blur
  return (
    <div className="flex items-center gap-2">
      <label
        className="text-[11px] text-neutral-400 shrink-0"
        title={param.description || undefined}
      >
        {displayName}
      </label>
      <input
        type="text"
        value={localValue}
        onFocus={() => { isFocusedRef.current = true; }}
        onChange={(e) => {
          setLocalValue(e.target.value);
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          handleChange(localValue || undefined);
        }}
        placeholder={param.default !== undefined ? `${param.default}` : undefined}
        className="nodrag nopan flex-1 min-w-0 text-[11px] py-1 px-2 rounded-md bg-[#1a1a1a] focus:outline-none focus:ring-1 focus:ring-neutral-600 text-white placeholder:text-neutral-500"
      />
    </div>
  );
}

// Memoized exports to prevent unnecessary re-renders
export const ModelParameters = React.memo(ModelParametersInner);
const ParameterInput = React.memo(ParameterInputInner);
