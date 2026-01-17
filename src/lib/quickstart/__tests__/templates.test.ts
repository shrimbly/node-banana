import { describe, it, expect } from "vitest";
import {
  getPresetTemplate,
  getAllPresets,
  getTemplateContent,
  PRESET_TEMPLATES,
  SAMPLE_IMAGES,
  ContentLevel,
} from "../templates";

describe("templates", () => {
  describe("SAMPLE_IMAGES", () => {
    it("should have all expected product images", () => {
      expect(SAMPLE_IMAGES.appleWatch).toBe("/sample-images/apple-watch.jpg");
      expect(SAMPLE_IMAGES.nikeShoe).toBe("/sample-images/nike-shoe.jpg");
      expect(SAMPLE_IMAGES.rayban).toBe("/sample-images/rayban.jpg");
    });

    it("should have all expected model images", () => {
      expect(SAMPLE_IMAGES.model).toBe("/sample-images/model.jpg");
      expect(SAMPLE_IMAGES.model2).toBe("/sample-images/model-2.jpg");
      expect(SAMPLE_IMAGES.model3).toBe("/sample-images/model-3.jpg");
    });

    it("should have all expected scene images", () => {
      expect(SAMPLE_IMAGES.desert).toBe("/sample-images/desert.jpg");
      expect(SAMPLE_IMAGES.streetScene).toBe("/sample-images/street-scene.jpg");
      expect(SAMPLE_IMAGES.nyStreet).toBe("/sample-images/ny-street.jpg");
    });
  });

  describe("PRESET_TEMPLATES", () => {
    it("should have 6 preset templates", () => {
      expect(PRESET_TEMPLATES).toHaveLength(6);
    });

    it("should have all required template IDs", () => {
      const templateIds = PRESET_TEMPLATES.map((t) => t.id);
      expect(templateIds).toContain("product-shot");
      expect(templateIds).toContain("model-product");
      expect(templateIds).toContain("color-variations");
      expect(templateIds).toContain("background-swap");
      expect(templateIds).toContain("style-transfer");
      expect(templateIds).toContain("scene-composite");
    });

    it("each template should have required properties", () => {
      PRESET_TEMPLATES.forEach((template) => {
        expect(template).toHaveProperty("id");
        expect(template).toHaveProperty("name");
        expect(template).toHaveProperty("description");
        expect(template).toHaveProperty("icon");
        expect(template).toHaveProperty("workflow");
      });
    });

    it("each template workflow should have valid structure", () => {
      PRESET_TEMPLATES.forEach((template) => {
        const { workflow } = template;
        expect(workflow.version).toBe(1);
        expect(workflow.name).toBeTruthy();
        expect(workflow.edgeStyle).toBe("curved");
        expect(Array.isArray(workflow.nodes)).toBe(true);
        expect(Array.isArray(workflow.edges)).toBe(true);
        expect(workflow.nodes.length).toBeGreaterThan(0);
      });
    });

    it("each template should have at least one nanoBanana node", () => {
      PRESET_TEMPLATES.forEach((template) => {
        const nanoBananaNodes = template.workflow.nodes.filter(
          (n) => n.type === "nanoBanana"
        );
        expect(nanoBananaNodes.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("each template should have at least one output node", () => {
      PRESET_TEMPLATES.forEach((template) => {
        const outputNodes = template.workflow.nodes.filter(
          (n) => n.type === "output"
        );
        expect(outputNodes.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("edges should reference valid node IDs", () => {
      PRESET_TEMPLATES.forEach((template) => {
        const nodeIds = new Set(template.workflow.nodes.map((n) => n.id));
        template.workflow.edges.forEach((edge) => {
          expect(nodeIds.has(edge.source)).toBe(true);
          expect(nodeIds.has(edge.target)).toBe(true);
        });
      });
    });
  });

  describe("getAllPresets", () => {
    it("should return all 6 presets", () => {
      const presets = getAllPresets();
      expect(presets).toHaveLength(6);
    });

    it("should return only display properties", () => {
      const presets = getAllPresets();
      presets.forEach((preset) => {
        expect(Object.keys(preset)).toEqual(["id", "name", "description", "icon", "category", "tags"]);
      });
    });

    it("should not include workflow data", () => {
      const presets = getAllPresets();
      presets.forEach((preset) => {
        expect(preset).not.toHaveProperty("workflow");
      });
    });
  });

  describe("getPresetTemplate", () => {
    const contentLevels: ContentLevel[] = ["empty", "minimal", "full"];

    it("should throw error for invalid template ID", () => {
      expect(() => getPresetTemplate("invalid-id", "minimal")).toThrow(
        "Template not found: invalid-id"
      );
    });

    it("should return workflow with generated ID", () => {
      const workflow = getPresetTemplate("product-shot", "empty");
      expect(workflow.id).toMatch(/^wf_\d+_product-shot$/);
    });

    describe("empty content level", () => {
      it("should have empty prompts", () => {
        const workflow = getPresetTemplate("product-shot", "empty");
        const promptNodes = workflow.nodes.filter((n) => n.type === "prompt");
        promptNodes.forEach((node) => {
          expect((node.data as { prompt: string }).prompt).toBe("");
        });
      });

      it("should have no pre-loaded images", () => {
        const workflow = getPresetTemplate("product-shot", "empty");
        const imageNodes = workflow.nodes.filter((n) => n.type === "imageInput");
        imageNodes.forEach((node) => {
          expect((node.data as { image: string | null }).image).toBeNull();
        });
      });
    });

    describe("minimal content level", () => {
      it("should have instructional prompts", () => {
        const workflow = getPresetTemplate("product-shot", "minimal");
        const promptNodes = workflow.nodes.filter((n) => n.type === "prompt");
        promptNodes.forEach((node) => {
          const prompt = (node.data as { prompt: string }).prompt;
          expect(prompt.length).toBeGreaterThan(0);
          expect(prompt).toContain("Consider:");
        });
      });

      it("should have no pre-loaded images", () => {
        const workflow = getPresetTemplate("product-shot", "minimal");
        const imageNodes = workflow.nodes.filter((n) => n.type === "imageInput");
        imageNodes.forEach((node) => {
          expect((node.data as { image: string | null }).image).toBeNull();
        });
      });
    });

    describe("full content level", () => {
      it("should have complete prompts", () => {
        const workflow = getPresetTemplate("product-shot", "full");
        const promptNodes = workflow.nodes.filter((n) => n.type === "prompt");
        promptNodes.forEach((node) => {
          const prompt = (node.data as { prompt: string }).prompt;
          expect(prompt.length).toBeGreaterThan(50);
        });
      });

      it("should have pre-loaded images with local paths", () => {
        const workflow = getPresetTemplate("product-shot", "full");
        const imageNodes = workflow.nodes.filter((n) => n.type === "imageInput");
        const nodesWithImages = imageNodes.filter(
          (node) => (node.data as { image: string | null }).image !== null
        );
        expect(nodesWithImages.length).toBeGreaterThan(0);
        nodesWithImages.forEach((node) => {
          const image = (node.data as { image: string }).image;
          expect(image).toMatch(/^\/sample-images\/.+\.jpg$/);
        });
      });

      it("should have filenames for images", () => {
        const workflow = getPresetTemplate("product-shot", "full");
        const imageNodes = workflow.nodes.filter((n) => n.type === "imageInput");
        const nodesWithImages = imageNodes.filter(
          (node) => (node.data as { image: string | null }).image !== null
        );
        nodesWithImages.forEach((node) => {
          const filename = (node.data as { filename: string }).filename;
          expect(filename).toMatch(/\.jpg$/);
        });
      });
    });

    it("should work for all templates at all content levels", () => {
      const templateIds = PRESET_TEMPLATES.map((t) => t.id);
      templateIds.forEach((templateId) => {
        contentLevels.forEach((level) => {
          expect(() => getPresetTemplate(templateId, level)).not.toThrow();
          const workflow = getPresetTemplate(templateId, level);
          expect(workflow.nodes.length).toBeGreaterThan(0);
          expect(workflow.edges.length).toBeGreaterThan(0);
        });
      });
    });
  });

  describe("getTemplateContent", () => {
    it("should return content for valid template and level", () => {
      const content = getTemplateContent("product-shot", "full");
      expect(content).not.toBeNull();
      expect(content).toHaveProperty("prompts");
      expect(content).toHaveProperty("images");
    });

    it("should return null for invalid template", () => {
      const content = getTemplateContent("invalid-id", "full");
      expect(content).toBeNull();
    });

    it("should have prompts object", () => {
      const content = getTemplateContent("product-shot", "minimal");
      expect(content?.prompts).toBeDefined();
      expect(typeof content?.prompts).toBe("object");
    });

    it("should have images object for full level", () => {
      const content = getTemplateContent("product-shot", "full");
      expect(content?.images).toBeDefined();
      expect(Object.keys(content?.images || {}).length).toBeGreaterThan(0);
    });

    it("should have empty images object for empty/minimal levels", () => {
      const emptyContent = getTemplateContent("product-shot", "empty");
      const minimalContent = getTemplateContent("product-shot", "minimal");
      expect(Object.keys(emptyContent?.images || {}).length).toBe(0);
      expect(Object.keys(minimalContent?.images || {}).length).toBe(0);
    });
  });

  describe("template-specific tests", () => {
    describe("product-shot template", () => {
      it("should have 2 image inputs (product and scene)", () => {
        const workflow = getPresetTemplate("product-shot", "empty");
        const imageInputs = workflow.nodes.filter((n) => n.type === "imageInput");
        expect(imageInputs.length).toBe(2);
      });

      it("full level should have nike shoe and desert images", () => {
        const workflow = getPresetTemplate("product-shot", "full");
        const images = workflow.nodes
          .filter((n) => n.type === "imageInput")
          .map((n) => (n.data as { image: string | null }).image)
          .filter(Boolean);
        expect(images).toContain(SAMPLE_IMAGES.nikeShoe);
        expect(images).toContain(SAMPLE_IMAGES.desert);
      });
    });

    describe("model-product template", () => {
      it("should have 3 image inputs (model, product, scene)", () => {
        const workflow = getPresetTemplate("model-product", "empty");
        const imageInputs = workflow.nodes.filter((n) => n.type === "imageInput");
        expect(imageInputs.length).toBe(3);
      });
    });

    describe("color-variations template", () => {
      it("should have 3 image inputs (product and color refs)", () => {
        const workflow = getPresetTemplate("color-variations", "empty");
        const imageInputs = workflow.nodes.filter((n) => n.type === "imageInput");
        expect(imageInputs.length).toBe(3);
      });
    });

    describe("style-transfer template", () => {
      it("should have 2 image inputs (style and content)", () => {
        const workflow = getPresetTemplate("style-transfer", "empty");
        const imageInputs = workflow.nodes.filter((n) => n.type === "imageInput");
        expect(imageInputs.length).toBe(2);
      });
    });
  });
});
