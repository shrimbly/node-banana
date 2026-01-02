import { describe, it, expect } from "vitest";
import {
  validateWorkflowJSON,
  repairWorkflowJSON,
  parseJSONFromResponse,
} from "../validation";

describe("validation", () => {
  describe("validateWorkflowJSON", () => {
    describe("root validation", () => {
      it("should reject null input", () => {
        const result = validateWorkflowJSON(null);
        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          path: "",
          message: "Workflow must be an object",
        });
      });

      it("should reject undefined input", () => {
        const result = validateWorkflowJSON(undefined);
        expect(result.valid).toBe(false);
      });

      it("should reject primitive types", () => {
        expect(validateWorkflowJSON("string").valid).toBe(false);
        expect(validateWorkflowJSON(123).valid).toBe(false);
        expect(validateWorkflowJSON(true).valid).toBe(false);
      });
    });

    describe("version validation", () => {
      it("should reject missing version", () => {
        const result = validateWorkflowJSON({ nodes: [], edges: [] });
        expect(result.errors).toContainEqual({
          path: "version",
          message: "Version must be 1",
        });
      });

      it("should reject invalid version", () => {
        const result = validateWorkflowJSON({ version: 2, nodes: [], edges: [] });
        expect(result.errors).toContainEqual({
          path: "version",
          message: "Version must be 1",
        });
      });

      it("should accept version 1", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: [],
          edges: [],
        });
        expect(result.errors.filter((e) => e.path === "version")).toHaveLength(0);
      });
    });

    describe("name validation", () => {
      it("should reject missing name", () => {
        const result = validateWorkflowJSON({ version: 1, nodes: [], edges: [] });
        expect(result.errors).toContainEqual({
          path: "name",
          message: "Name must be a non-empty string",
        });
      });

      it("should reject empty name", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "",
          nodes: [],
          edges: [],
        });
        expect(result.errors).toContainEqual({
          path: "name",
          message: "Name must be a non-empty string",
        });
      });

      it("should accept valid name", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test Workflow",
          nodes: [],
          edges: [],
        });
        expect(result.errors.filter((e) => e.path === "name")).toHaveLength(0);
      });
    });

    describe("nodes validation", () => {
      it("should reject missing nodes array", () => {
        const result = validateWorkflowJSON({ version: 1, name: "Test", edges: [] });
        expect(result.errors).toContainEqual({
          path: "nodes",
          message: "Nodes must be an array",
        });
      });

      it("should reject non-array nodes", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: "not an array",
          edges: [],
        });
        expect(result.errors).toContainEqual({
          path: "nodes",
          message: "Nodes must be an array",
        });
      });

      it("should reject node without id", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: [{ type: "prompt", position: { x: 0, y: 0 }, data: {} }],
          edges: [],
        });
        expect(result.errors).toContainEqual({
          path: "nodes[0].id",
          message: "Node must have a string id",
        });
      });

      it("should reject duplicate node ids", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: [
            { id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} },
            { id: "node-1", type: "prompt", position: { x: 100, y: 0 }, data: {} },
          ],
          edges: [],
        });
        expect(result.errors).toContainEqual({
          path: "nodes[1].id",
          message: "Duplicate node id: node-1",
        });
      });

      it("should reject invalid node type", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: [{ id: "node-1", type: "invalid", position: { x: 0, y: 0 }, data: {} }],
          edges: [],
        });
        expect(result.errors.some((e) => e.path === "nodes[0].type")).toBe(true);
      });

      it("should accept all valid node types", () => {
        const validTypes = [
          "imageInput",
          "annotation",
          "prompt",
          "nanoBanana",
          "llmGenerate",
          "splitGrid",
          "output",
        ];
        validTypes.forEach((type) => {
          const result = validateWorkflowJSON({
            version: 1,
            name: "Test",
            nodes: [{ id: "node-1", type, position: { x: 0, y: 0 }, data: {} }],
            edges: [],
          });
          expect(
            result.errors.filter((e) => e.path === "nodes[0].type")
          ).toHaveLength(0);
        });
      });

      it("should reject node without position", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: [{ id: "node-1", type: "prompt", data: {} }],
          edges: [],
        });
        expect(result.errors).toContainEqual({
          path: "nodes[0].position",
          message: "Node must have a position object",
        });
      });

      it("should reject node with invalid position", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: [{ id: "node-1", type: "prompt", position: { x: "0", y: "0" }, data: {} }],
          edges: [],
        });
        expect(result.errors).toContainEqual({
          path: "nodes[0].position",
          message: "Position must have numeric x and y values",
        });
      });

      it("should reject node without data", () => {
        const result = validateWorkflowJSON({
          version: 1,
          name: "Test",
          nodes: [{ id: "node-1", type: "prompt", position: { x: 0, y: 0 } }],
          edges: [],
        });
        expect(result.errors).toContainEqual({
          path: "nodes[0].data",
          message: "Node must have a data object",
        });
      });
    });

    describe("edges validation", () => {
      const validWorkflow = {
        version: 1,
        name: "Test",
        nodes: [
          { id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} },
          { id: "node-2", type: "nanoBanana", position: { x: 100, y: 0 }, data: {} },
        ],
      };

      it("should reject missing edges array", () => {
        const result = validateWorkflowJSON(validWorkflow);
        expect(result.errors).toContainEqual({
          path: "edges",
          message: "Edges must be an array",
        });
      });

      it("should reject edge with non-existent source", () => {
        const result = validateWorkflowJSON({
          ...validWorkflow,
          edges: [{ source: "invalid", target: "node-2" }],
        });
        expect(result.errors).toContainEqual({
          path: "edges[0].source",
          message: "Source node not found: invalid",
        });
      });

      it("should reject edge with non-existent target", () => {
        const result = validateWorkflowJSON({
          ...validWorkflow,
          edges: [{ source: "node-1", target: "invalid" }],
        });
        expect(result.errors).toContainEqual({
          path: "edges[0].target",
          message: "Target node not found: invalid",
        });
      });

      it("should reject invalid sourceHandle", () => {
        const result = validateWorkflowJSON({
          ...validWorkflow,
          edges: [{ source: "node-1", target: "node-2", sourceHandle: "invalid" }],
        });
        expect(result.errors).toContainEqual({
          path: "edges[0].sourceHandle",
          message: "Invalid sourceHandle: invalid",
        });
      });

      it("should reject invalid targetHandle", () => {
        const result = validateWorkflowJSON({
          ...validWorkflow,
          edges: [{ source: "node-1", target: "node-2", targetHandle: "invalid" }],
        });
        expect(result.errors).toContainEqual({
          path: "edges[0].targetHandle",
          message: "Invalid targetHandle: invalid",
        });
      });

      it("should reject mismatched handle types", () => {
        const result = validateWorkflowJSON({
          ...validWorkflow,
          edges: [
            { source: "node-1", target: "node-2", sourceHandle: "text", targetHandle: "image" },
          ],
        });
        expect(result.errors).toContainEqual({
          path: "edges[0]",
          message: "Handle type mismatch: text → image",
        });
      });

      it("should accept matching handle types", () => {
        const result = validateWorkflowJSON({
          ...validWorkflow,
          edges: [
            { source: "node-1", target: "node-2", sourceHandle: "text", targetHandle: "text" },
          ],
        });
        expect(result.errors.filter((e) => e.message.includes("mismatch"))).toHaveLength(0);
      });

      it("should accept reference handle type connections", () => {
        const result = validateWorkflowJSON({
          ...validWorkflow,
          edges: [
            { source: "node-1", target: "node-2", sourceHandle: "reference", targetHandle: "image" },
          ],
        });
        expect(result.errors.filter((e) => e.message.includes("mismatch"))).toHaveLength(0);
      });
    });

    describe("valid workflow", () => {
      it("should validate a complete valid workflow", () => {
        const workflow = {
          version: 1,
          name: "Test Workflow",
          nodes: [
            { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "test" } },
            {
              id: "nanoBanana-1",
              type: "nanoBanana",
              position: { x: 400, y: 0 },
              data: {},
            },
            { id: "output-1", type: "output", position: { x: 800, y: 0 }, data: {} },
          ],
          edges: [
            { source: "prompt-1", target: "nanoBanana-1", sourceHandle: "text", targetHandle: "text" },
            {
              source: "nanoBanana-1",
              target: "output-1",
              sourceHandle: "image",
              targetHandle: "image",
            },
          ],
        };
        const result = validateWorkflowJSON(workflow);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });
  });

  describe("repairWorkflowJSON", () => {
    it("should handle null input", () => {
      const result = repairWorkflowJSON(null);
      expect(result.version).toBe(1);
      expect(result.name).toBe("Generated Workflow");
      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    it("should add missing version", () => {
      const result = repairWorkflowJSON({ name: "Test", nodes: [], edges: [] });
      expect(result.version).toBe(1);
    });

    it("should add missing name", () => {
      const result = repairWorkflowJSON({ version: 1, nodes: [], edges: [] });
      expect(result.name).toBe("Generated Workflow");
    });

    it("should preserve existing name", () => {
      const result = repairWorkflowJSON({ name: "My Workflow", nodes: [], edges: [] });
      expect(result.name).toBe("My Workflow");
    });

    it("should generate id if missing", () => {
      const result = repairWorkflowJSON({ nodes: [], edges: [] });
      expect(result.id).toMatch(/^wf_\d+_repaired$/);
    });

    it("should set default edgeStyle", () => {
      const result = repairWorkflowJSON({ nodes: [], edges: [] });
      expect(result.edgeStyle).toBe("curved");
    });

    it("should repair node with missing id", () => {
      const result = repairWorkflowJSON({
        nodes: [{ type: "prompt", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      });
      expect(result.nodes[0].id).toBe("prompt-1");
    });

    it("should repair node with invalid type", () => {
      const result = repairWorkflowJSON({
        nodes: [{ id: "node-1", type: "invalid", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      });
      expect(result.nodes[0].type).toBe("prompt");
    });

    it("should repair node with missing position", () => {
      const result = repairWorkflowJSON({
        nodes: [{ id: "node-1", type: "prompt", data: {} }],
        edges: [],
      });
      expect(result.nodes[0].position).toEqual({ x: 50, y: 100 });
    });

    it("should add default dimensions to nodes", () => {
      const result = repairWorkflowJSON({
        nodes: [{ id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      });
      expect(result.nodes[0].style).toEqual({ width: 320, height: 220 });
    });

    it("should fill in default node data", () => {
      const result = repairWorkflowJSON({
        nodes: [{ id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      });
      expect(result.nodes[0].data).toHaveProperty("prompt");
    });

    it("should remove edges with non-existent source", () => {
      const result = repairWorkflowJSON({
        nodes: [{ id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} }],
        edges: [{ source: "invalid", target: "node-1" }],
      });
      expect(result.edges).toHaveLength(0);
    });

    it("should remove edges with non-existent target", () => {
      const result = repairWorkflowJSON({
        nodes: [{ id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} }],
        edges: [{ source: "node-1", target: "invalid" }],
      });
      expect(result.edges).toHaveLength(0);
    });

    it("should remove edges with mismatched handle types", () => {
      const result = repairWorkflowJSON({
        nodes: [
          { id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} },
          { id: "node-2", type: "nanoBanana", position: { x: 100, y: 0 }, data: {} },
        ],
        edges: [{ source: "node-1", target: "node-2", sourceHandle: "text", targetHandle: "image" }],
      });
      expect(result.edges).toHaveLength(0);
    });

    it("should keep valid edges", () => {
      const result = repairWorkflowJSON({
        nodes: [
          { id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} },
          { id: "node-2", type: "nanoBanana", position: { x: 100, y: 0 }, data: {} },
        ],
        edges: [{ source: "node-1", target: "node-2", sourceHandle: "text", targetHandle: "text" }],
      });
      expect(result.edges).toHaveLength(1);
    });

    it("should generate edge id if missing", () => {
      const result = repairWorkflowJSON({
        nodes: [
          { id: "node-1", type: "prompt", position: { x: 0, y: 0 }, data: {} },
          { id: "node-2", type: "nanoBanana", position: { x: 100, y: 0 }, data: {} },
        ],
        edges: [{ source: "node-1", target: "node-2", sourceHandle: "text", targetHandle: "text" }],
      });
      expect(result.edges[0].id).toBe("edge-node-1-node-2-text-text");
    });
  });

  describe("parseJSONFromResponse", () => {
    it("should parse valid JSON directly", () => {
      const result = parseJSONFromResponse('{"key": "value"}');
      expect(result).toEqual({ key: "value" });
    });

    it("should parse JSON from markdown code block", () => {
      const text = 'Here is the workflow:\n```json\n{"key": "value"}\n```';
      const result = parseJSONFromResponse(text);
      expect(result).toEqual({ key: "value" });
    });

    it("should parse JSON from code block without language", () => {
      const text = "Here is the workflow:\n```\n{\"key\": \"value\"}\n```";
      const result = parseJSONFromResponse(text);
      expect(result).toEqual({ key: "value" });
    });

    it("should extract JSON object from text", () => {
      const text = 'Some text before {"key": "value"} and after';
      const result = parseJSONFromResponse(text);
      expect(result).toEqual({ key: "value" });
    });

    it("should parse complex nested JSON", () => {
      const json = {
        version: 1,
        name: "Test",
        nodes: [{ id: "node-1", type: "prompt" }],
        edges: [],
      };
      const result = parseJSONFromResponse(JSON.stringify(json));
      expect(result).toEqual(json);
    });

    it("should throw error for invalid JSON", () => {
      expect(() => parseJSONFromResponse("not json")).toThrow(
        "Could not parse JSON from response"
      );
    });

    it("should throw error for empty string", () => {
      expect(() => parseJSONFromResponse("")).toThrow(
        "Could not parse JSON from response"
      );
    });

    it("should handle JSON with whitespace", () => {
      const text = "  \n\n  {\"key\": \"value\"}  \n\n  ";
      const result = parseJSONFromResponse(text);
      expect(result).toEqual({ key: "value" });
    });
  });
});
