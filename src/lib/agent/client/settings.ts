/**
 * Agent panel preferences: which harness to talk to and the model picked for
 * each one. Stored in localStorage next to the other Node Banana settings.
 *
 * Nothing secret lives here — the harnesses sign in through the vendors' own
 * CLIs and the app never sees a token.
 */

import { AGENT_HARNESS_IDS, type AgentHarnessId, type AgentModelOption } from "../types";

export const AGENT_SETTINGS_KEY = "node-banana-agent-settings";

export interface AgentClientSettings {
  harness: AgentHarnessId;
  /** The model last picked per harness. Absent means the harness default. */
  models: Partial<Record<AgentHarnessId, string>>;
  /** The thinking effort last picked per harness; kept across models, used where the model offers it. */
  efforts: Partial<Record<AgentHarnessId, string>>;
}

export const DEFAULT_AGENT_SETTINGS: AgentClientSettings = {
  harness: "claude",
  models: {},
  efforts: {},
};

export function isAgentHarnessId(value: unknown): value is AgentHarnessId {
  return typeof value === "string" && (AGENT_HARNESS_IDS as readonly string[]).includes(value);
}

/** Keeps only well-formed fields, so a hand-edited or older entry cannot break the panel. */
export function sanitizeAgentSettings(raw: unknown): AgentClientSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AGENT_SETTINGS, models: {}, efforts: {} };
  const record = raw as Record<string, unknown>;
  return {
    harness: isAgentHarnessId(record.harness) ? record.harness : DEFAULT_AGENT_SETTINGS.harness,
    models: perHarness(record.models),
    efforts: perHarness(record.efforts),
  };
}

function perHarness(raw: unknown): Partial<Record<AgentHarnessId, string>> {
  const values: Partial<Record<AgentHarnessId, string>> = {};
  if (raw && typeof raw === "object") {
    for (const [harness, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isAgentHarnessId(harness) && typeof value === "string" && value.trim()) values[harness] = value;
    }
  }
  return values;
}

export function loadAgentSettings(): AgentClientSettings {
  try {
    const stored = localStorage.getItem(AGENT_SETTINGS_KEY);
    return sanitizeAgentSettings(stored ? JSON.parse(stored) : null);
  } catch {
    // Unavailable storage (private mode, SSR) or a corrupt entry: fall back to defaults.
    return sanitizeAgentSettings(null);
  }
}

export function saveAgentSettings(settings: AgentClientSettings): void {
  try {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(sanitizeAgentSettings(settings)));
  } catch {
    // Quota or disabled storage: the choice still applies for this session.
  }
}

/**
 * The model to send for a harness: the user's pick when the harness still
 * offers it, else the harness default, else the first option. Undefined when
 * the harness lists no models (the CLI then uses its own default).
 */
export function resolveAgentModel(
  options: readonly AgentModelOption[] | undefined,
  preferred?: string,
): string | undefined {
  if (!options || options.length === 0) return undefined;
  if (preferred && options.some((option) => option.id === preferred)) return preferred;
  return (options.find((option) => option.isDefault) ?? options[0]).id;
}

/**
 * The effort to send with a model: the user's pick when the model offers it,
 * else the model's default. Undefined when the model has no effort levels.
 */
export function resolveAgentEffort(option: AgentModelOption | undefined, preferred?: string): string | undefined {
  const efforts = option?.efforts;
  if (!efforts || efforts.length === 0) return undefined;
  if (preferred && efforts.includes(preferred)) return preferred;
  return option.defaultEffort && efforts.includes(option.defaultEffort) ? option.defaultEffort : efforts[0];
}
