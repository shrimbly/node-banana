"use client";

import { useMemo, useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { indexOfNode } from "@/store/nodeChanges";
import type { ModelInputDef, SelectedModel } from "@/types";
import type { SchemaModel } from "./ModelParameters";
import { useDerivedNodeData, useIsPaintedNode } from "./paintMode";
import { sameInputSchema } from "./ui/schemaSockets";

/** The fields a generate node keeps from its models' schemas. */
interface SchemaFields {
  selectedModel?: SelectedModel;
  fallbackModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  fallbackParameters?: Record<string, unknown>;
  inputSchema?: ModelInputDef[];
}

/**
 * What a generate node stores from its models' schemas (the inputs that
 * become its sockets, the defaults its parameters lack), for ModelParameters'
 * onInputsLoaded and onDefaults. `data` is the node's data as rendered.
 *
 * Written from a painted copy too (useDerivedNodeData): on the GPU canvas a
 * node is mostly painted, and classic stores these as soon as it mounts. A
 * copy can be a batch behind the store, so there each write is checked
 * against the stored node: only for the model it still has, merged into its
 * current parameters, and only when something is missing or different.
 */
export function useSchemaDerived(id: string, data: SchemaFields) {
  const derive = useDerivedNodeData();
  const painted = useIsPaintedNode();
  const dataRef = useRef(data);
  dataRef.current = data;
  return useMemo(() => {
    const current = (): SchemaFields | undefined => {
      if (!painted) return dataRef.current;
      const { nodes } = useWorkflowStore.getState();
      const i = indexOfNode(nodes, id);
      return i >= 0 ? (nodes[i].data as SchemaFields) : undefined;
    };
    const defaultsFor = (field: "parameters" | "fallbackParameters", modelField: "selectedModel" | "fallbackModel") =>
      (defaults: Record<string, unknown>, model: SchemaModel) => {
        const data = current();
        if (!data || data[modelField]?.modelId !== model.modelId) return;
        const parameters = data[field] ?? {};
        const missing = Object.entries(defaults).filter(([name]) => parameters[name] === undefined);
        if (missing.length) derive(id, { [field]: { ...parameters, ...Object.fromEntries(missing) } });
      };
    return {
      // ModelParameters reports on every mount, and a culled node remounts on
      // every pan; a schema the node already has must not dirty the workflow.
      inputsLoaded: (inputs: ModelInputDef[], model: SchemaModel) => {
        const data = current();
        if (!data || (data.selectedModel?.modelId ?? "") !== model.modelId) return;
        if (sameInputSchema(data.inputSchema, inputs)) return;
        derive(id, { inputSchema: inputs });
      },
      defaults: defaultsFor("parameters", "selectedModel"),
      fallbackDefaults: defaultsFor("fallbackParameters", "fallbackModel"),
    };
  }, [id, derive, painted]);
}
