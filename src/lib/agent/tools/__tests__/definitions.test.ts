import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AGENT_TOOL_DEFINITIONS } from "../definitions";
import { createAgentToolRuntime } from "../runtime";
import { emptySnapshot } from "./testUtils";

describe("tool definitions", () => {
  it("have unique snake_case names, titles and teaching descriptions", () => {
    const names = AGENT_TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of AGENT_TOOL_DEFINITIONS) {
      expect(definition.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(definition.title.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(80);
    }
    expect(AGENT_TOOL_DEFINITIONS.filter((d) => d.readOnly).map((d) => d.name)).toEqual(["get_workflow", "describe_node_types", "list_models"]);
  });

  it.each(AGENT_TOOL_DEFINITIONS.map((d) => [d.name, d] as const))("%s converts to an object JSON Schema (Codex dynamic tools)", (_name, definition) => {
    const schema = z.toJSONSchema(z.object(definition.inputShape)) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeTypeOf("object");
    // Round-trips through JSON (what the app-server receives).
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    // No top-level unions: some vendors reject anyOf/oneOf at the root.
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
  });

  it("describes nested structures with properties the model can read", () => {
    const edit = AGENT_TOOL_DEFINITIONS.find((d) => d.name === "edit_workflow")!;
    const schema = z.toJSONSchema(z.object(edit.inputShape)) as unknown as {
      required?: string[];
      properties: { operations: { type: string; items: { properties: Record<string, { enum?: string[]; description?: string }> } } };
    };
    expect(schema.required).toEqual(["operations"]);
    expect(schema.properties.operations.type).toBe("array");
    expect(schema.properties.operations.items.properties.op.enum).toEqual(["add_node", "update_node", "remove_node", "connect", "disconnect", "move_node"]);
    expect(schema.properties.operations.items.properties.settings.description).toContain("describe_node_types");
  });

  it("are the runtime's definitions", () => {
    expect(createAgentToolRuntime(emptySnapshot()).definitions).toBe(AGENT_TOOL_DEFINITIONS);
  });
});
