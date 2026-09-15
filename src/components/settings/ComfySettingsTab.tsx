"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  COMFY_CLOUD_URL,
  COMFY_LOCAL_URL,
  buildComfyHeaders,
  comfyConfigError,
  getComfySettings,
  type ComfySettings,
} from "@/lib/comfy/settings";
import type { ComfyBackendMode } from "@/lib/comfy/types";

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
    <div className="space-y-4">
      <div>
        <label className="block text-sm text-neutral-400 mb-2">Run workflows on</label>
        <div className="grid grid-cols-3 gap-1.5 p-1 bg-neutral-900/50 rounded-lg">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => update({ mode: mode.value })}
              title={mode.hint}
              className={`px-3 py-1.5 text-sm rounded-md transition-all duration-150 ${
                settings.mode === mode.value
                  ? "bg-neutral-700 text-neutral-100 font-medium"
                  : "text-neutral-400 hover:text-neutral-300 hover:bg-neutral-800/50"
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-neutral-500 mt-1.5">
          {MODES.find((m) => m.value === settings.mode)?.hint}
        </p>
      </div>

      {settings.mode === "cloud" && (
        <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700 space-y-3">
          <Field label="API key">
            <div className="flex items-center gap-2">
              <input
                type={showKey ? "text" : "password"}
                value={settings.cloudApiKey ?? ""}
                onChange={(e) => update({ cloudApiKey: e.target.value || null })}
                placeholder="comfyui-..."
                className="flex-1 min-w-0 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            <a
              href="https://platform.comfy.org/profile/api-keys"
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-neutral-500 hover:text-neutral-300 mt-1 inline-block"
            >
              Get a key at platform.comfy.org →
            </a>
          </Field>

          {settings.cloudUrl !== COMFY_CLOUD_URL && (
            <Field label="Cloud URL">
              <input
                type="text"
                value={settings.cloudUrl}
                onChange={(e) => update({ cloudUrl: e.target.value })}
                className="w-full px-2 py-1 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
              />
            </Field>
          )}
        </div>
      )}

      {settings.mode === "local" && (
        <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700 space-y-3">
          <Field label="ComfyUI URL">
            <input
              type="text"
              value={settings.localUrl}
              onChange={(e) => update({ localUrl: e.target.value })}
              placeholder={COMFY_LOCAL_URL}
              className="w-full px-2 py-1 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
            />
          </Field>
          <ApiV2Toggle
            checked={settings.localUsesApiV2}
            onChange={(localUsesApiV2) => update({ localUsesApiV2 })}
          />
          <p className="text-[10px] text-neutral-500">
            A workflow only runs here if this ComfyUI has the models and custom nodes it needs.
          </p>
        </div>
      )}

      {settings.mode === "remote" && (
        <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700 space-y-3">
          <Field label="ComfyUI URL">
            <input
              type="text"
              value={settings.remoteUrl}
              onChange={(e) => update({ remoteUrl: e.target.value })}
              placeholder="http://192.168.1.20:8188"
              className="w-full px-2 py-1 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
            />
          </Field>
          <Field label="API key (optional)">
            <input
              type="password"
              value={settings.remoteApiKey ?? ""}
              onChange={(e) => update({ remoteApiKey: e.target.value || null })}
              placeholder="Only if it sits behind auth"
              className="w-full px-2 py-1 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
            />
          </Field>
          <ApiV2Toggle
            checked={settings.remoteUsesApiV2}
            onChange={(remoteUsesApiV2) => update({ remoteUsesApiV2 })}
          />
        </div>
      )}

      {/* Connection test */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={test}
          disabled={testing || Boolean(configError)}
          className="px-3 py-1.5 text-xs rounded-lg bg-neutral-700 hover:bg-neutral-600 text-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        {configError && <span className="text-[11px] text-amber-400">{configError}</span>}
        {result && (
          <span
            className={`text-[11px] ${result.connected ? "text-green-400" : "text-red-400"}`}
          >
            {result.connected
              ? `Connected${result.nodeCount ? ` · ${result.nodeCount} node types` : ""}${
                  result.apiV2 ? " · API v2" : ""
                }`
              : result.detail}
          </span>
        )}
      </div>

      {/* Advanced */}
      <details className="group">
        <summary className="text-xs text-neutral-500 hover:text-neutral-300 cursor-pointer select-none list-none flex items-center gap-1">
          <svg
            className="w-3 h-3 transition-transform group-open:rotate-90"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          Advanced
        </summary>

        <div className="mt-3 p-3 bg-neutral-900 rounded-lg border border-neutral-700 space-y-3">
          <Field label="Comfy API-node key">
            <div className="flex items-center gap-2">
              <input
                type={showOrgKey ? "text" : "password"}
                value={settings.comfyOrgApiKey ?? ""}
                onChange={(e) => update({ comfyOrgApiKey: e.target.value || null })}
                placeholder={settings.cloudApiKey ? "Same as the Cloud key" : "comfyui-..."}
                className="flex-1 min-w-0 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
              />
              <button
                type="button"
                onClick={() => setShowOrgKey((v) => !v)}
                className="text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
              >
                {showOrgKey ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-[10px] text-neutral-500 mt-1">
              Authenticates partner nodes (Gemini, Kling, …) inside a workflow, wherever it runs.
            </p>
          </Field>

          <Field label="Job timeout">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={60}
                value={Math.round(settings.jobTimeoutMs / 60_000)}
                onChange={(e) => {
                  const minutes = Number(e.target.value);
                  if (Number.isFinite(minutes)) update({ jobTimeoutMs: minutes * 60_000 });
                }}
                className="w-16 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
              />
              <span className="text-xs text-neutral-500">minutes</span>
            </div>
          </Field>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.randomizeSeeds}
              onChange={(e) => update({ randomizeSeeds: e.target.checked })}
              className="w-3.5 h-3.5 rounded bg-neutral-800"
            />
            <span className="text-xs text-neutral-300">Randomise seeds on every run</span>
          </label>
          <p className="text-[10px] text-neutral-500 -mt-1.5">
            Off means repeat runs return the workflow&apos;s saved seed — and identical results.
            A seed you set on a node is always kept either way.
          </p>
        </div>
      </details>
    </div>
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
    <div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-3.5 h-3.5 rounded bg-neutral-800"
        />
        <span className="text-xs text-neutral-300">Behind comfy-api-proxy</span>
      </label>
      <p className="text-[10px] text-neutral-500 mt-1">
        Turn on only if this endpoint serves the Comfy API v2. A stock ComfyUI does not —
        leave it off and Node Banana drives it directly.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-neutral-400 mb-1">{label}</label>
      {children}
    </div>
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
