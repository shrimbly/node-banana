import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSISTANT_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  LEGACY_LLM_MODELS,
  LLM_MODELS,
  LLM_PROVIDER_OPTIONS,
  defaultLLMModel,
  describeLLMModels,
  isCurrentLLMModel,
  llmModelLabel,
  llmModelOptions,
  resolveLLMModel,
} from "../catalog";

describe("LLM catalogue", () => {
  it("has unique ids across current and legacy models", () => {
    const ids = [...LLM_MODELS.map((m) => m.id), ...LEGACY_LLM_MODELS.map((m) => m.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers at least one model per provider", () => {
    for (const { value } of LLM_PROVIDER_OPTIONS) {
      expect(LLM_MODELS.some((m) => m.provider === value)).toBe(true);
      expect(defaultLLMModel(value)).toBe(LLM_MODELS.find((m) => m.provider === value)?.id);
    }
  });

  it("points every retired model at a current one of the same provider", () => {
    for (const legacy of LEGACY_LLM_MODELS) {
      if (legacy.status !== "retired") continue;
      expect(legacy.replacement, `${legacy.id} needs a replacement`).toBeDefined();
      const replacement = LLM_MODELS.find((m) => m.id === legacy.replacement);
      expect(replacement?.provider).toBe(legacy.provider);
    }
  });

  it("uses current models for the defaults", () => {
    expect(isCurrentLLMModel(DEFAULT_LLM_MODEL)).toBe(true);
    expect(LLM_MODELS.find((m) => m.id === DEFAULT_LLM_MODEL)?.provider).toBe(DEFAULT_LLM_PROVIDER);
    expect(LLM_MODELS.find((m) => m.id === ASSISTANT_MODEL)?.provider).toBe("google");
  });

  it("keeps hard-coded ids out of the contributor docs", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    for (const doc of ["CLAUDE.md", "AGENTS.md"]) {
      const text = readFileSync(join(root, doc), "utf8");
      expect(text, `${doc} should point at the catalogue`).toContain("src/lib/llm/catalog.ts");
      for (const id of [...LLM_MODELS, ...LEGACY_LLM_MODELS].map((m) => m.id)) {
        expect(text, `${doc} names ${id}; list models in the catalogue only`).not.toContain(`\`${id}\``);
      }
    }
  });
});

describe("resolveLLMModel", () => {
  it("passes a current model through", () => {
    expect(resolveLLMModel("google", "gemini-2.5-flash")).toMatchObject({
      id: "gemini-2.5-flash",
      apiId: "gemini-2.5-flash",
    });
    expect(resolveLLMModel("google", "gemini-2.5-flash")?.substitution).toBeUndefined();
  });

  it("maps a served legacy id to its API id without substituting", () => {
    expect(resolveLLMModel("anthropic", "claude-sonnet-4.5")).toMatchObject({
      id: "claude-sonnet-4.5",
      apiId: "claude-sonnet-4-5-20250929",
    });
    expect(resolveLLMModel("anthropic", "claude-sonnet-4.5")?.substitution).toBeUndefined();
  });

  it("replaces a retired id and explains the change", () => {
    const resolved = resolveLLMModel("google", "gemini-3-pro-preview");
    expect(resolved).toMatchObject({ id: "gemini-3.1-pro-preview", apiId: "gemini-3.1-pro-preview" });
    expect(resolved?.substitution?.from).toBe("gemini-3-pro-preview");
    expect(resolved?.substitution?.note).toContain("gemini-3.1-pro-preview");
  });

  it("rejects unknown ids and ids from another provider", () => {
    expect(resolveLLMModel("google", "some-model")).toBeNull();
    expect(resolveLLMModel("openai", "gemini-2.5-flash")).toBeNull();
    expect(resolveLLMModel("google", "claude-sonnet-4.5")).toBeNull();
  });
});

describe("dropdown helpers", () => {
  it("lists only current models by default", () => {
    const values = llmModelOptions("openai").map((o) => o.value);
    expect(values).toEqual(LLM_MODELS.filter((m) => m.provider === "openai").map((m) => m.id));
  });

  it("keeps a node's legacy selection in its own provider's list, labelled", () => {
    const options = llmModelOptions("openai", "gpt-4.1-mini");
    expect(options.at(-1)).toEqual({ value: "gpt-4.1-mini", label: "GPT-4.1 Mini (legacy)" });
    expect(llmModelOptions("google", "gpt-4.1-mini").some((o) => o.value === "gpt-4.1-mini")).toBe(false);
  });

  it("labels unknown ids with the raw id", () => {
    expect(llmModelLabel("mystery-9000")).toBe("mystery-9000");
    expect(llmModelOptions("google", "mystery-9000").at(-1)?.value).toBe("mystery-9000");
  });

  it("describes every provider's menu in one line", () => {
    const text = describeLLMModels();
    for (const m of LLM_MODELS) expect(text).toContain(m.label);
    for (const { label } of LLM_PROVIDER_OPTIONS) expect(text).toContain(`(${label})`);
  });
});
