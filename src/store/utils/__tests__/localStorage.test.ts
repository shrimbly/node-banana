import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  STORAGE_KEY,
  COST_DATA_STORAGE_KEY,
  GENERATE_IMAGE_DEFAULTS_KEY,
  PROVIDER_SETTINGS_KEY,
  NODE_DEFAULTS_KEY,
  loadSaveConfigs,
  saveSaveConfig,
  loadWorkflowCostData,
  saveWorkflowCostData,
  loadGenerateImageDefaults,
  saveGenerateImageDefaults,
  getProviderSettings,
  saveProviderSettings,
  defaultProviderSettings,
  generateWorkflowId,
  loadNodeDefaults,
  saveNodeDefaults,
  getGenerateImageDefaults,
  getGenerateVideoDefaults,
  getLLMDefaults,
} from "../localStorage";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

describe("localStorage utilities", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe("loadSaveConfigs", () => {
    it("returns empty object when localStorage is empty", () => {
      const result = loadSaveConfigs();
      expect(result).toEqual({});
    });

    it("returns stored configs when data exists", () => {
      const mockConfigs = {
        "wf_123": {
          workflowId: "wf_123",
          name: "Test Workflow",
          path: "/path/to/workflow",
          lastSaved: Date.now(),
        },
      };
      localStorageMock.setItem(STORAGE_KEY, JSON.stringify(mockConfigs));

      const result = loadSaveConfigs();
      expect(result).toEqual(mockConfigs);
    });
  });

  describe("saveSaveConfig", () => {
    it("stores and retrieves config", () => {
      const config = {
        workflowId: "wf_456",
        name: "New Workflow",
        path: "/path/to/new",
        lastSaved: Date.now(),
      };

      saveSaveConfig(config);

      const stored = JSON.parse(localStorageMock.getItem(STORAGE_KEY)!);
      expect(stored["wf_456"]).toEqual(config);
    });

    it("merges with existing configs", () => {
      const existingConfig = {
        workflowId: "wf_existing",
        name: "Existing",
        path: "/existing",
        lastSaved: Date.now(),
      };
      localStorageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({ "wf_existing": existingConfig })
      );

      const newConfig = {
        workflowId: "wf_new",
        name: "New",
        path: "/new",
        lastSaved: Date.now(),
      };
      saveSaveConfig(newConfig);

      const stored = JSON.parse(localStorageMock.getItem(STORAGE_KEY)!);
      expect(stored["wf_existing"]).toEqual(existingConfig);
      expect(stored["wf_new"]).toEqual(newConfig);
    });
  });

  describe("loadWorkflowCostData", () => {
    it("returns null when localStorage is empty", () => {
      const result = loadWorkflowCostData("wf_123");
      expect(result).toBeNull();
    });

    it("returns null when workflow not found", () => {
      localStorageMock.setItem(
        COST_DATA_STORAGE_KEY,
        JSON.stringify({ "wf_other": { workflowId: "wf_other", totalCost: 10 } })
      );

      const result = loadWorkflowCostData("wf_missing");
      expect(result).toBeNull();
    });

    it("returns cost data when found", () => {
      const costData = { workflowId: "wf_123", totalCost: 5.5 };
      localStorageMock.setItem(
        COST_DATA_STORAGE_KEY,
        JSON.stringify({ "wf_123": costData })
      );

      const result = loadWorkflowCostData("wf_123");
      expect(result).toEqual(costData);
    });

    it("returns null on invalid JSON", () => {
      localStorageMock.setItem(COST_DATA_STORAGE_KEY, "invalid json");

      const result = loadWorkflowCostData("wf_123");
      expect(result).toBeNull();
    });
  });

  describe("saveWorkflowCostData", () => {
    it("stores cost data", () => {
      const costData = { workflowId: "wf_789", totalCost: 2.5 };

      saveWorkflowCostData(costData);

      const stored = JSON.parse(localStorageMock.getItem(COST_DATA_STORAGE_KEY)!);
      expect(stored["wf_789"]).toEqual(costData);
    });
  });

  describe("loadGenerateImageDefaults", () => {
    it("returns default settings when localStorage is empty", () => {
      const result = loadGenerateImageDefaults();
      expect(result).toEqual({
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana-pro",
        useGoogleSearch: false,
      });
    });

    it("returns stored settings when data exists", () => {
      const customSettings = {
        aspectRatio: "16:9",
        resolution: "2K",
        model: "nano-banana",
        useGoogleSearch: true,
      };
      localStorageMock.setItem(
        GENERATE_IMAGE_DEFAULTS_KEY,
        JSON.stringify(customSettings)
      );

      const result = loadGenerateImageDefaults();
      expect(result).toEqual(customSettings);
    });

    it("returns default on invalid JSON", () => {
      localStorageMock.setItem(GENERATE_IMAGE_DEFAULTS_KEY, "not valid json");

      const result = loadGenerateImageDefaults();
      expect(result).toEqual({
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana-pro",
        useGoogleSearch: false,
      });
    });
  });

  describe("saveGenerateImageDefaults", () => {
    it("merges partial settings with existing", () => {
      const existing = {
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana-pro",
        useGoogleSearch: false,
      };
      localStorageMock.setItem(
        GENERATE_IMAGE_DEFAULTS_KEY,
        JSON.stringify(existing)
      );

      saveGenerateImageDefaults({ aspectRatio: "4:3" });

      const stored = JSON.parse(localStorageMock.getItem(GENERATE_IMAGE_DEFAULTS_KEY)!);
      expect(stored).toEqual({
        ...existing,
        aspectRatio: "4:3",
      });
    });
  });

  describe("getProviderSettings", () => {
    it("returns default settings when localStorage is empty", () => {
      const result = getProviderSettings();
      expect(result).toEqual(defaultProviderSettings);
    });

    it("merges with defaults for new providers", () => {
      // Simulate old settings missing a new provider
      const oldSettings = {
        providers: {
          gemini: { id: "gemini", name: "Google Gemini", enabled: true, apiKey: "test-key" },
        },
      };
      localStorageMock.setItem(
        PROVIDER_SETTINGS_KEY,
        JSON.stringify(oldSettings)
      );

      const result = getProviderSettings();
      // Should have the stored gemini settings
      expect(result.providers.gemini.apiKey).toBe("test-key");
      // Should also have the default providers that were missing
      expect(result.providers.replicate).toBeDefined();
      expect(result.providers.fal).toBeDefined();
    });

    it("returns default on invalid JSON", () => {
      localStorageMock.setItem(PROVIDER_SETTINGS_KEY, "invalid");

      const result = getProviderSettings();
      expect(result).toEqual(defaultProviderSettings);
    });
  });

  describe("saveProviderSettings", () => {
    it("stores provider settings", () => {
      const settings = {
        providers: {
          gemini: { id: "gemini", name: "Gemini", enabled: true, apiKey: "key123" },
        },
      };

      saveProviderSettings(settings as any);

      const stored = JSON.parse(localStorageMock.getItem(PROVIDER_SETTINGS_KEY)!);
      expect(stored).toEqual(settings);
    });
  });

  describe("generateWorkflowId", () => {
    it("generates unique IDs", () => {
      const id1 = generateWorkflowId();
      const id2 = generateWorkflowId();

      expect(id1).not.toBe(id2);
    });

    it("has correct format", () => {
      const id = generateWorkflowId();

      expect(id).toMatch(/^wf_\d+_[a-z0-9]+$/);
    });
  });

  describe("loadNodeDefaults", () => {
    it("returns empty object when localStorage is empty", () => {
      const result = loadNodeDefaults();
      expect(result).toEqual({});
    });

    it("returns stored config when data exists", () => {
      const config = {
        generateImage: {
          selectedModel: { provider: "fal", modelId: "test-model", displayName: "Test Model" },
          aspectRatio: "16:9",
        },
        llm: {
          provider: "openai",
          model: "gpt-4.1-mini",
        },
      };
      localStorageMock.setItem(NODE_DEFAULTS_KEY, JSON.stringify(config));

      const result = loadNodeDefaults();
      expect(result).toEqual(config);
    });

    it("returns empty object on invalid JSON", () => {
      localStorageMock.setItem(NODE_DEFAULTS_KEY, "not valid json");

      const result = loadNodeDefaults();
      expect(result).toEqual({});
    });
  });

  describe("saveNodeDefaults", () => {
    it("stores config to localStorage", () => {
      const config = {
        generateVideo: {
          selectedModel: { provider: "replicate", modelId: "video-model", displayName: "Video Model" },
        },
      };

      saveNodeDefaults(config);

      const stored = JSON.parse(localStorageMock.getItem(NODE_DEFAULTS_KEY)!);
      expect(stored).toEqual(config);
    });
  });

  describe("getGenerateImageDefaults", () => {
    it("returns undefined when not configured", () => {
      const result = getGenerateImageDefaults();
      expect(result).toBeUndefined();
    });

    it("returns stored generateImage defaults when configured", () => {
      const config = {
        generateImage: {
          selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
          aspectRatio: "4:3",
          useGoogleSearch: true,
        },
      };
      localStorageMock.setItem(NODE_DEFAULTS_KEY, JSON.stringify(config));

      const result = getGenerateImageDefaults();
      expect(result).toEqual(config.generateImage);
    });
  });

  describe("getGenerateVideoDefaults", () => {
    it("returns undefined when not configured", () => {
      const result = getGenerateVideoDefaults();
      expect(result).toBeUndefined();
    });

    it("returns stored generateVideo defaults when configured", () => {
      const config = {
        generateVideo: {
          selectedModel: { provider: "fal", modelId: "kling-video", displayName: "Kling Video" },
        },
      };
      localStorageMock.setItem(NODE_DEFAULTS_KEY, JSON.stringify(config));

      const result = getGenerateVideoDefaults();
      expect(result).toEqual(config.generateVideo);
    });
  });

  describe("getLLMDefaults", () => {
    it("returns undefined when not configured", () => {
      const result = getLLMDefaults();
      expect(result).toBeUndefined();
    });

    it("returns stored llm defaults when configured", () => {
      const config = {
        llm: {
          provider: "openai",
          model: "gpt-4.1-nano",
          temperature: 0.5,
          maxTokens: 4096,
        },
      };
      localStorageMock.setItem(NODE_DEFAULTS_KEY, JSON.stringify(config));

      const result = getLLMDefaults();
      expect(result).toEqual(config.llm);
    });
  });
});
