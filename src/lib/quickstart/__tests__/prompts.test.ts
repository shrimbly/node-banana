import { describe, it, expect } from "vitest";
import { buildQuickstartPrompt, buildSimplePrompt } from "../prompts";
import { ContentLevel } from "../templates";

describe("prompts", () => {
  describe("buildQuickstartPrompt", () => {
    it("should include the user description", () => {
      const description = "Create a portrait editing workflow";
      const prompt = buildQuickstartPrompt(description, "minimal");
      expect(prompt).toContain(description);
    });

    it("should include content level instructions", () => {
      const emptyPrompt = buildQuickstartPrompt("test", "empty");
      const minimalPrompt = buildQuickstartPrompt("test", "minimal");
      const fullPrompt = buildQuickstartPrompt("test", "full");

      expect(emptyPrompt).toContain("Content Level: EMPTY");
      expect(emptyPrompt).toContain("Leave ALL prompt fields completely empty");

      expect(minimalPrompt).toContain("Content Level: MINIMAL");
      expect(minimalPrompt).toContain("placeholder prompts");

      expect(fullPrompt).toContain("Content Level: FULL");
      expect(fullPrompt).toContain("complete, detailed example prompts");
    });

    it("should include all node type descriptions", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("imageInput");
      expect(prompt).toContain("prompt");
      expect(prompt).toContain("nanoBanana");
      expect(prompt).toContain("llmGenerate");
      expect(prompt).toContain("annotation");
      expect(prompt).toContain("output");
    });

    it("should include connection rules", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("Connection Rules");
      expect(prompt).toContain("image\" handles can ONLY connect to \"image\" handles");
      expect(prompt).toContain("text\" handles can ONLY connect to \"text\" handles");
    });

    it("should include node layout guidelines", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("Node Layout Guidelines");
      expect(prompt).toContain("400px");
      expect(prompt).toContain("left to right");
    });

    it("should include required JSON structure", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("Required JSON Structure");
      expect(prompt).toContain('"version": 1');
      expect(prompt).toContain('"nodes"');
      expect(prompt).toContain('"edges"');
      expect(prompt).toContain('"edgeStyle": "curved"');
    });

    it("should include node dimension specifications", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("imageInput: { width: 300, height: 280 }");
      expect(prompt).toContain("prompt: { width: 320, height: 220 }");
      expect(prompt).toContain("nanoBanana: { width: 300, height: 300 }");
    });

    it("should include node ID format instructions", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("Node ID Format");
      expect(prompt).toContain('"{type}-{number}"');
      expect(prompt).toContain("imageInput-1");
    });

    it("should include edge ID format instructions", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("Edge ID Format");
      expect(prompt).toContain("edge-{source}-{target}");
    });

    it("should include a timestamp in the workflow ID", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toMatch(/wf_\d+_quickstart/);
    });

    it("should emphasize nanoBanana requirements", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("nanoBanana REQUIRES both an image input AND a text input");
    });

    it("should instruct to output only JSON", () => {
      const prompt = buildQuickstartPrompt("test", "minimal");
      expect(prompt).toContain("output ONLY valid JSON");
      expect(prompt).toContain("No explanations, no markdown, no code blocks");
    });

    describe("content level specific prompts", () => {
      const contentLevels: ContentLevel[] = ["empty", "minimal", "full"];

      contentLevels.forEach((level) => {
        it(`should generate valid prompt for ${level} level`, () => {
          const prompt = buildQuickstartPrompt("test workflow", level);
          expect(prompt).toBeTruthy();
          expect(prompt.length).toBeGreaterThan(1000);
          expect(prompt).toContain(`Content Level: ${level.toUpperCase()}`);
        });
      });
    });
  });

  describe("buildSimplePrompt", () => {
    it("should include the user description", () => {
      const description = "Create a simple editing workflow";
      const prompt = buildSimplePrompt(description);
      expect(prompt).toContain(description);
    });

    it("should list all node types", () => {
      const prompt = buildSimplePrompt("test");
      expect(prompt).toContain("imageInput");
      expect(prompt).toContain("prompt");
      expect(prompt).toContain("nanoBanana");
      expect(prompt).toContain("llmGenerate");
      expect(prompt).toContain("annotation");
      expect(prompt).toContain("output");
    });

    it("should include connection type rules", () => {
      const prompt = buildSimplePrompt("test");
      expect(prompt).toContain("image handles connect to image");
      expect(prompt).toContain("text to text");
    });

    it("should include nanoBanana requirements", () => {
      const prompt = buildSimplePrompt("test");
      expect(prompt).toContain("nanoBanana NEEDS both image and text inputs");
    });

    it("should include node ID format", () => {
      const prompt = buildSimplePrompt("test");
      expect(prompt).toContain("type-number");
      expect(prompt).toContain("imageInput-1");
    });

    it("should include edge ID format", () => {
      const prompt = buildSimplePrompt("test");
      expect(prompt).toContain("edge-source-target-sourceHandle-targetHandle");
    });

    it("should specify required JSON structure elements", () => {
      const prompt = buildSimplePrompt("test");
      expect(prompt).toContain("version:1");
      expect(prompt).toContain("nodes[]");
      expect(prompt).toContain("edges[]");
      expect(prompt).toContain('edgeStyle:"curved"');
    });

    it("should be shorter than the full prompt", () => {
      const simplePrompt = buildSimplePrompt("test");
      const fullPrompt = buildQuickstartPrompt("test", "full");
      expect(simplePrompt.length).toBeLessThan(fullPrompt.length);
    });

    it("should request only valid JSON output", () => {
      const prompt = buildSimplePrompt("test");
      expect(prompt).toContain("Return ONLY valid JSON");
    });
  });
});
