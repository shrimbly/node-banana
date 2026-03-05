"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
export function ModelParameters({
  modelId,
  provider,
  parameters,
  onParametersChange,
  onExpandChange,
  onInputsLoaded,
}: ModelParametersProps) {
  const [schema, setSchema] = useState<ModelParameter[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey } = useProviderApiKeys();

  // Fetch schema when modelId changes
  useEffect(() => {
    if (!modelId || provider === "gemini") {
      setSchema([]);
      onInputsLoaded?.([]);
      return;
    }

    const fetchSchema = async () => {
      // Check localStorage cache first
      const cached = getCachedSchema(modelId, provider);
      if (cached) {
        setSchema(cached.parameters);
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
        setSchema(params);

        // Cache the successful result
        setCachedSchema(modelId, provider, params, inputs);

        // Pass inputs to parent for dynamic handle rendering
        if (onInputsLoaded) {
          onInputsLoaded(inputs);
        }
      } catch (err) {
        console.error("Failed to fetch model schema:", err);
        setError(err instanceof Error ? err.message : "Failed to fetch schema");
        setSchema([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSchema();
  }, [modelId, provider, replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey, onInputsLoaded]);

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

  // Don't render anything for Gemini or if no model selected
  if (provider === "gemini" || !modelId) {
    return null;
  }

  // Don't render if no schema available and not loading
  if (!isLoading && schema.length === 0 && !error) {
    return null;
  }

  return (
    <div className="shrink-0 space-y-1.5">
      {error ? (
        <span className="text-[9px] text-red-400">{error}</span>
      ) : isLoading ? (
        <span className="text-[9px] text-neutral-500">Loading parameters...</span>
      ) : schema.length === 0 ? (
        <span className="text-[9px] text-neutral-500">No parameters available</span>
      ) : (
        schema.map((param) => (
          <ParameterInput
            key={param.name}
            param={param}
            value={parameters[param.name]}
            onChange={(value) => handleParameterChange(param.name, value)}
          />
        ))
      )}
    </div>
  );
}

interface ParameterInputProps {
  param: ModelParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}

/**
 * Individual parameter input based on type.
 * Text and number inputs use local state during editing to prevent
 * cursor-jump issues caused by React Flow re-renders on store updates.
 */
function ParameterInput({ param, value, onChange }: ParameterInputProps) {
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
      <div className="flex flex-col gap-0.5">
        <label
          className="text-[9px] text-neutral-400"
          title={param.description || undefined}
        >
          {displayName}
        </label>
        <select
          value={(value as string) ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") {
              onChange(undefined);
            } else if (param.type === "integer") {
              onChange(parseInt(val, 10));
            } else if (param.type === "number") {
              onChange(parseFloat(val));
            } else if (param.type === "boolean") {
              onChange(val === "true");
            } else {
              onChange(val);
            }
          }}
          className="nodrag nopan w-full text-[9px] py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
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
        className="flex items-center gap-1.5 text-[9px] text-neutral-400 cursor-pointer"
        title={param.description || undefined}
      >
        <input
          type="checkbox"
          checked={effectiveValue}
          onChange={(e) => onChange(e.target.checked)}
          className="nodrag nopan w-2.5 h-2.5 rounded border-neutral-700 bg-neutral-900/50 text-neutral-600 focus:ring-1 focus:ring-neutral-600 focus:ring-offset-0"
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
        <label
          className="text-[9px] text-neutral-400 flex items-center gap-1"
          title={param.description || undefined}
        >
          {displayName}
          {hasMin && hasMax && (
            <span className="text-neutral-500">
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
              onChange(undefined);
            } else {
              const num = param.type === "integer" ? parseInt(localValue, 10) : parseFloat(localValue);
              onChange(isNaN(num) ? undefined : num);
            }
          }}
          placeholder={param.default !== undefined ? `Default: ${param.default}` : undefined}
          className={`nodrag nopan w-full text-[9px] py-0.5 px-1 border rounded bg-neutral-900/50 focus:outline-none focus:ring-1 text-neutral-300 placeholder:text-neutral-600 ${
            validationError
              ? "border-red-500 focus:ring-red-500"
              : "border-neutral-700 focus:ring-neutral-600"
          }`}
        />
        {validationError && (
          <span className="text-[8px] text-red-400">{validationError}</span>
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
    <div className="flex flex-col gap-0.5">
      <label
        className="text-[9px] text-neutral-400"
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
          onChange(localValue || undefined);
        }}
        placeholder={param.default !== undefined ? `Default: ${param.default}` : undefined}
        className="nodrag nopan w-full text-[9px] py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300 placeholder:text-neutral-600"
      />
    </div>
  );
}
