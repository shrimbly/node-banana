"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  COMFY_CLOUD_URL,
  COMFY_LOCAL_URL,
  buildComfyHeaders,
  comfyConfigError,
  getComfySettings,
  type ComfySettings,
} from "@/lib/comfy/settings";
import type { ComfyBackendMode } from "@/lib/comfy/types";
import { DialogButton, DialogStatus } from "@/components/ui/Dialog";
import { Field, Segmented, Switch, TextInput, helpClass, inputClass, labelClass } from "@/components/ui/Controls";
import { cn } from "@/components/nodes/ui/cn";

interface ComfySettingsTabProps {
  settings: ComfySettings;
  onChange: (settings: ComfySettings) => void;
}

interface ConnectionResult {
  connected: boolean;
  detail: string;
  nodeCount: number | null;
  apiV2: boolean;
}

const MODES: Array<{ value: ComfyBackendMode; label: string; hint: string }> = [
  { value: "cloud", label: "Comfy Cloud", hint: "Runs on Comfy's GPUs — nothing to install." },
  { value: "local", label: "This computer", hint: "Your own ComfyUI, with your own models." },
  { value: "remote", label: "Remote", hint: "A ComfyUI elsewhere on your network." },
];

const MODE_OPTIONS = MODES.map((mode) => ({ value: mode.value, label: mode.label, title: mode.hint }));

/**
 * How Node Banana runs ComfyUI workflows.
 *
 * Cloud is the default because it works with nothing installed; local and
 * remote are there for people who already run their own ComfyUI and have the
 * models a workflow needs.
 */
export function ComfySettingsTab({ settings, onChange }: ComfySettingsTabProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [showOrgKey, setShowOrgKey] = useState(false);

  const configError = comfyConfigError(settings);

  // A different endpoint — or credential, or transport — invalidates the
  // previous probe, so clear it rather than leaving a green tick against a
  // configuration that was never tested. Every field the probe depends on
  // belongs here, including the two API-v2 toggles, which change the routes it
  // calls entirely.
  //
  // The counter is bumped alongside, so a probe still in flight can tell its
  // answer is about a configuration the user has moved on from. Clearing
  // `result` alone is not enough — the in-flight call captured the old settings
  // and would set its own result on top afterwards.
  const probeGeneration = useRef(0);

  useEffect(() => {
    probeGeneration.current += 1;
    // Released here, not only in the probe's own `finally` — which is skipped
    // once the generation has moved on, and skipping it left the Test button
    // disabled with nothing able to re-enable it.
    setTesting(false);
    setResult(null);
  }, [
    settings.mode,
    settings.cloudApiKey,
    settings.cloudUrl,
    settings.localUrl,
    settings.localUsesApiV2,
    settings.remoteUrl,
    settings.remoteApiKey,
    settings.remoteUsesApiV2,
  ]);

  const update = useCallback(
    (patch: Partial<ComfySettings>) => onChange({ ...settings, ...patch }),
    [onChange, settings]
  );

  const test = useCallback(async () => {
    const generation = probeGeneration.current;
    const commit = (next: ConnectionResult) => {
      if (probeGeneration.current === generation) setResult(next);
    };
    setTesting(true);
    setResult(null);
    try {
      // Probe the settings being edited, not the ones last saved.
      const response = await fetch("/api/comfy/status", {
        method: "POST",
        headers: buildComfyHeaders(settings),
      });
      const body = (await response.json()) as
        | ({ success: true } & ConnectionResult)
        | { success: false; error: string };
      if ("success" in body && body.success) {
        commit({
          connected: body.connected,
          detail: body.detail,
          nodeCount: body.nodeCount,
          apiV2: body.apiV2,
        });
      } else {
        commit({
          connected: false,
          detail: "error" in body ? body.error : "Could not reach ComfyUI",
          nodeCount: null,
          apiV2: false,
        });
      }
    } catch (error) {
      commit({
        connected: false,
        detail: error instanceof Error ? error.message : "Could not reach ComfyUI",
        nodeCount: null,
        apiV2: false,
      });
    } finally {
      if (probeGeneration.current === generation) setTesting(false);
    }
  }, [settings]);

  return (
    <div>
      <div>
        <span className={cn(labelClass, "mb-2")}>Run workflows on</span>
        <Segmented
          options={MODE_OPTIONS}
          value={settings.mode}
          onChange={(mode) => update({ mode })}
          label="Run workflows on"
        />
        <p className={helpClass}>{MODES.find((m) => m.value === settings.mode)?.hint}</p>
      </div>

      {/* The chosen mode's fields */}
      <div className="flex flex-col gap-3.5 mt-[18px] pt-[18px] border-t border-card">
        {settings.mode === "cloud" && (
          <>
            <Field id="comfy-cloud-key" label="API key">
              <div className="flex gap-2">
                <TextInput
                  id="comfy-cloud-key"
                  type={showKey ? "text" : "password"}
                  value={settings.cloudApiKey ?? ""}
                  onChange={(e) => update({ cloudApiKey: e.target.value || null })}
                  placeholder="comfyui-..."
                />
                <DialogButton variant="outline" size="md" className="shrink-0" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? "Hide" : "Show"}
                </DialogButton>
              </div>
            </Field>
            <a
              href="https://platform.comfy.org/profile/api-keys"
              target="_blank"
              rel="noreferrer"
              className="-mt-1.5 self-start inline-flex items-center gap-1.5 text-xs leading-4 text-neutral-400 hover:text-neutral-100 transition-colors"
            >
              Get a key at platform.comfy.org
              <ArrowIcon />
            </a>

            {settings.cloudUrl !== COMFY_CLOUD_URL && (
              <Field id="comfy-cloud-url" label="Cloud URL">
                <TextInput
                  id="comfy-cloud-url"
                  type="text"
                  value={settings.cloudUrl}
                  onChange={(e) => update({ cloudUrl: e.target.value })}
                />
              </Field>
            )}
          </>
        )}

        {settings.mode === "local" && (
          <>
            <Field id="comfy-local-url" label="ComfyUI URL">
              <TextInput
                id="comfy-local-url"
                type="text"
                value={settings.localUrl}
                onChange={(e) => update({ localUrl: e.target.value })}
                placeholder={COMFY_LOCAL_URL}
              />
            </Field>
            <ApiV2Toggle
              checked={settings.localUsesApiV2}
              onChange={(localUsesApiV2) => update({ localUsesApiV2 })}
            />
            <p className="text-xs leading-4 text-neutral-500">
              A workflow only runs here if this ComfyUI has the models and custom nodes it needs.
            </p>
          </>
        )}

        {settings.mode === "remote" && (
          <>
            <Field id="comfy-remote-url" label="ComfyUI URL">
              <TextInput
                id="comfy-remote-url"
                type="text"
                value={settings.remoteUrl}
                onChange={(e) => update({ remoteUrl: e.target.value })}
                placeholder="http://192.168.1.20:8188"
              />
            </Field>
            <Field id="comfy-remote-key" label="API key (optional)">
              <TextInput
                id="comfy-remote-key"
                type="password"
                value={settings.remoteApiKey ?? ""}
                onChange={(e) => update({ remoteApiKey: e.target.value || null })}
                placeholder="Only if it sits behind auth"
              />
            </Field>
            <ApiV2Toggle
              checked={settings.remoteUsesApiV2}
              onChange={(remoteUsesApiV2) => update({ remoteUsesApiV2 })}
            />
          </>
        )}
      </div>

      {/* Connection test */}
      <div className="flex items-center gap-3.5 mt-[18px] pt-[18px] border-t border-card">
        <DialogButton
          variant="outline"
          size="md"
          className="h-8 shrink-0"
          onClick={test}
          disabled={testing || Boolean(configError)}
        >
          {testing ? "Testing…" : "Test connection"}
        </DialogButton>
        {configError && <span className="text-xs leading-4 text-amber-400">{configError}</span>}
        {result && (
          <DialogStatus tone={result.connected ? "ok" : "error"}>
            {result.connected
              ? `Connected${result.nodeCount ? ` · ${result.nodeCount} node types` : ""}${
                  result.apiV2 ? " · API v2" : ""
                }`
              : result.detail}
          </DialogStatus>
        )}
      </div>

      {/* Advanced */}
      <details className="group mt-[18px] pt-3 border-t border-card">
        <summary
          className={cn(
            "list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none inline-flex items-center gap-2 rounded",
            "font-display text-[13px] font-medium text-neutral-400 hover:text-neutral-100 group-open:text-neutral-100 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          )}
        >
          <svg
            className="w-3.5 h-3.5 transition-transform group-open:rotate-90"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          Advanced
        </summary>

        <div className="flex flex-col gap-3 mt-3">
          <Field
            id="comfy-org-key"
            label="Comfy API-node key"
            help="Authenticates partner nodes (Gemini, Kling, …) inside a workflow, wherever it runs."
          >
            <div className="flex gap-2">
              <TextInput
                id="comfy-org-key"
                type={showOrgKey ? "text" : "password"}
                value={settings.comfyOrgApiKey ?? ""}
                onChange={(e) => update({ comfyOrgApiKey: e.target.value || null })}
                placeholder={settings.cloudApiKey ? "Same as the Cloud key" : "comfyui-..."}
              />
              <DialogButton variant="outline" size="md" className="shrink-0" onClick={() => setShowOrgKey((v) => !v)}>
                {showOrgKey ? "Hide" : "Show"}
              </DialogButton>
            </div>
          </Field>

          <div className="flex items-center justify-between gap-6">
            <label htmlFor="comfy-job-timeout" className={cn(labelClass, "mb-0")}>
              Job timeout
            </label>
            <div className="flex items-center gap-2">
              <input
                id="comfy-job-timeout"
                type="number"
                min={1}
                max={60}
                value={Math.round(settings.jobTimeoutMs / 60_000)}
                onChange={(e) => {
                  const minutes = Number(e.target.value);
                  if (Number.isFinite(minutes)) update({ jobTimeoutMs: minutes * 60_000 });
                }}
                className={cn(inputClass, "w-16 h-8 px-2.5")}
              />
              <span className="text-xs text-neutral-400">minutes</span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="text-[13px] leading-[18px] text-neutral-100">Randomise seeds on every run</div>
              <p className="mt-0.5 text-xs leading-4 text-ink-3">
                Off means repeat runs return the workflow&apos;s saved seed — and identical results.
                A seed you set on a node is always kept either way.
              </p>
            </div>
            <Switch
              checked={settings.randomizeSeeds}
              onChange={(randomizeSeeds) => update({ randomizeSeeds })}
              label="Randomise seeds on every run"
            />
          </div>
        </div>
      </details>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function ApiV2Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 shrink-0 rounded accent-neutral-200"
      />
      <span>
        <span className="block text-[13px] leading-[18px] text-neutral-100">Behind comfy-api-proxy</span>
        <span className="block text-xs leading-4 text-ink-3">
          Turn on only if this endpoint serves the Comfy API v2. A stock ComfyUI does not —
          leave it off and Node Banana drives it directly.
        </span>
      </span>
    </label>
  );
}

/** Read the stored settings once on mount, for a modal that opens with them. */
export function useComfySettingsDraft(isOpen: boolean) {
  const [draft, setDraft] = useState<ComfySettings>(() => getComfySettings());
  const [editedFields] = useState(() => new Set<keyof ComfySettings>());
  useEffect(() => {
    if (isOpen) { editedFields.clear(); setDraft(getComfySettings()); }
  }, [isOpen]);
  const updateDraft = (settings: ComfySettings) => {
    for (const key of Object.keys(settings) as (keyof ComfySettings)[]) {
      if (settings[key] !== draft[key]) editedFields.add(key);
    }
    setDraft(settings);
  };
  const applyImported = (settings: ComfySettings, fields: (keyof ComfySettings)[]) => {
    setDraft(previous => {
      const next = { ...previous };
      for (const key of fields) if (!editedFields.has(key)) Object.assign(next, { [key]: settings[key] });
      return next;
    });
  };
  return [draft, updateDraft, applyImported] as const;
}
