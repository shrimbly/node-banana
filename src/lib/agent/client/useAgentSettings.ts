"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentHarnessId } from "../types";
import { loadAgentSettings, saveAgentSettings, type AgentClientSettings } from "./settings";

export interface UseAgentSettingsResult {
  settings: AgentClientSettings;
  setHarness: (harness: AgentHarnessId) => void;
  setModel: (harness: AgentHarnessId, model: string) => void;
  setEffort: (harness: AgentHarnessId, effort: string) => void;
}

/** The persisted harness and per-harness model choice. Client-only (reads localStorage on mount). */
export function useAgentSettings(): UseAgentSettingsResult {
  const [settings, setSettings] = useState<AgentClientSettings>(loadAgentSettings);
  const loaded = useRef(true);

  useEffect(() => {
    // The first run is the value just loaded; only write real changes.
    if (loaded.current) {
      loaded.current = false;
      return;
    }
    saveAgentSettings(settings);
  }, [settings]);

  const setHarness = useCallback((harness: AgentHarnessId) => {
    setSettings((previous) => (previous.harness === harness ? previous : { ...previous, harness }));
  }, []);

  const setModel = useCallback((harness: AgentHarnessId, model: string) => {
    setSettings((previous) =>
      previous.models[harness] === model
        ? previous
        : { ...previous, models: { ...previous.models, [harness]: model } },
    );
  }, []);

  const setEffort = useCallback((harness: AgentHarnessId, effort: string) => {
    setSettings((previous) =>
      previous.efforts[harness] === effort
        ? previous
        : { ...previous, efforts: { ...previous.efforts, [harness]: effort } },
    );
  }, []);

  return { settings, setHarness, setModel, setEffort };
}
