import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  AGENT_SETTINGS_KEY,
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  resolveAgentModel,
  sanitizeAgentSettings,
  saveAgentSettings,
} from "../settings";
import { useAgentSettings } from "../useAgentSettings";

describe("agent settings persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to Claude Code with no model picks", () => {
    expect(loadAgentSettings()).toEqual(DEFAULT_AGENT_SETTINGS);
  });

  it("round-trips harness and per-harness models", () => {
    saveAgentSettings({ harness: "codex", models: { claude: "opus", codex: "gpt-5.6-luna" } });
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY)!)).toEqual({
      harness: "codex",
      models: { claude: "opus", codex: "gpt-5.6-luna" },
    });
    expect(loadAgentSettings()).toEqual({ harness: "codex", models: { claude: "opus", codex: "gpt-5.6-luna" } });
  });

  it("falls back to defaults for corrupt JSON", () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, "{not json");
    expect(loadAgentSettings()).toEqual(DEFAULT_AGENT_SETTINGS);
  });

  it("drops unknown harnesses and malformed models", () => {
    expect(
      sanitizeAgentSettings({ harness: "gemini", models: { claude: "sonnet", gemini: "x", codex: 42, extra: "" } }),
    ).toEqual({ harness: "claude", models: { claude: "sonnet" } });
    expect(sanitizeAgentSettings("codex")).toEqual(DEFAULT_AGENT_SETTINGS);
    expect(sanitizeAgentSettings({ harness: "codex", models: { codex: "  " } })).toEqual({
      harness: "codex",
      models: {},
    });
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(loadAgentSettings()).toEqual(DEFAULT_AGENT_SETTINGS);
    expect(() => saveAgentSettings({ harness: "codex", models: {} })).not.toThrow();
  });
});

describe("resolveAgentModel", () => {
  const models = [
    { id: "default", label: "Default" },
    { id: "sonnet", label: "Sonnet", isDefault: true },
    { id: "opus", label: "Opus" },
  ];

  it("keeps the user's pick while the harness still offers it", () => {
    expect(resolveAgentModel(models, "opus")).toBe("opus");
  });

  it("falls back to the harness default, then the first option", () => {
    expect(resolveAgentModel(models, "retired-model")).toBe("sonnet");
    expect(resolveAgentModel(models)).toBe("sonnet");
    expect(resolveAgentModel([{ id: "a", label: "A" }, { id: "b", label: "B" }])).toBe("a");
  });

  it("is undefined when the harness lists no models", () => {
    expect(resolveAgentModel([], "opus")).toBeUndefined();
    expect(resolveAgentModel(undefined)).toBeUndefined();
  });
});

describe("useAgentSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads the stored choice and does not rewrite it on mount", () => {
    saveAgentSettings({ harness: "codex", models: { codex: "gpt-5.6-luna" } });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useAgentSettings());
    expect(result.current.settings).toEqual({ harness: "codex", models: { codex: "gpt-5.6-luna" } });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("persists harness and model changes", () => {
    const { result } = renderHook(() => useAgentSettings());
    act(() => result.current.setHarness("codex"));
    act(() => result.current.setModel("codex", "gpt-5.6-luna"));
    act(() => result.current.setModel("claude", "haiku"));

    expect(result.current.settings).toEqual({
      harness: "codex",
      models: { codex: "gpt-5.6-luna", claude: "haiku" },
    });
    expect(loadAgentSettings()).toEqual(result.current.settings);
  });
});
