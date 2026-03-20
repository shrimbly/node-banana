"use client";

import { useCallback, useState, useEffect, useMemo, useRef, ReactNode } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { usePromptAutocomplete } from "@/hooks/usePromptAutocomplete";
import { useWorkflowStore } from "@/store/workflowStore";
import { PromptConstructorNodeData, PromptNodeData, LLMGenerateNodeData, ImageInputNodeData, AvailableVariable } from "@/types";
import { parseVarTags } from "@/utils/parseVarTags";

type PromptConstructorNodeType = Node<PromptConstructorNodeData, "promptConstructor">;

export function PromptConstructorNode({ id, data, selected }: NodeProps<PromptConstructorNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);

  // Local state for template to prevent cursor jumping
  const [localTemplate, setLocalTemplate] = useState(nodeData.template);
  const [isEditing, setIsEditing] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync from props when not actively editing
  useEffect(() => {
    if (!isEditing) {
      setLocalTemplate(nodeData.template);
    }
  }, [nodeData.template, isEditing]);

  // Get available variables from connected prompt nodes (named variables + inline <var> tags)
  // and image variables from connected image nodes
  const availableVariables = useMemo((): AvailableVariable[] => {
    const connectedTextNodes = edges
      .filter((e) => e.target === id && e.targetHandle === "text")
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is typeof nodes[0] => n !== undefined);

    const connectedImageNodes = edges
      .filter((e) => e.target === id && e.targetHandle === "image")
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is typeof nodes[0] => n !== undefined);

    const vars: AvailableVariable[] = [];
    const usedNames = new Set<string>();

    // First pass: named variables from Prompt nodes (these take precedence)
    connectedTextNodes.forEach((node) => {
      if (node.type === "prompt") {
        const promptData = node.data as PromptNodeData;
        if (promptData.variableName) {
          vars.push({
            name: promptData.variableName,
            value: promptData.prompt || "",
            nodeId: node.id,
            variableType: "text",
          });
          usedNames.add(promptData.variableName);
        }
      }
    });

    // Image variables from connected ImageInput nodes with variableName
    connectedImageNodes.forEach((node) => {
      if (node.type === "imageInput") {
        const imgData = node.data as ImageInputNodeData;
        if (imgData.variableName && !usedNames.has(imgData.variableName)) {
          vars.push({
            name: imgData.variableName,
            value: imgData.image ? "(image)" : "(no image)",
            nodeId: node.id,
            variableType: "image",
          });
          usedNames.add(imgData.variableName);
        }
      }
    });

    // Parse inline <var> tags from all connected text nodes
    connectedTextNodes.forEach((node) => {
      let text: string | null = null;
      if (node.type === "prompt") {
        text = (node.data as PromptNodeData).prompt || null;
      } else if (node.type === "llmGenerate") {
        text = (node.data as LLMGenerateNodeData).outputText || null;
      } else if (node.type === "promptConstructor") {
        const pcData = node.data as PromptConstructorNodeData;
        text = pcData.outputText ?? pcData.template ?? null;
      }

      if (text) {
        const parsed = parseVarTags(text);
        parsed.forEach(({ name, value }) => {
          if (!usedNames.has(name)) {
            vars.push({
              name,
              value,
              nodeId: `${node.id}-var-${name}`,
              variableType: "text",
            });
            usedNames.add(name);
          }
        });
      }
    });

    return vars;
  }, [edges, nodes, id]);

  // Autocomplete via shared hook
  const {
    showAutocomplete,
    autocompletePosition,
    filteredAutocompleteVars,
    selectedAutocompleteIndex,
    handleChange,
    handleKeyDown,
    handleAutocompleteSelect,
    closeAutocomplete,
  } = usePromptAutocomplete({
    availableVariables,
    textareaRef,
    localTemplate,
    setLocalTemplate,
    onTemplateCommit: (newTemplate) => updateNodeData(id, { template: newTemplate }),
  });

  // Compute unresolved variables client-side
  const unresolvedVars = useMemo(() => {
    const varPattern = /@(\w+)/g;
    const unresolved: string[] = [];
    const matches = localTemplate.matchAll(varPattern);
    const availableNames = new Set(availableVariables.map(v => v.name));

    for (const match of matches) {
      const varName = match[1];
      if (!availableNames.has(varName) && !unresolved.includes(varName)) {
        unresolved.push(varName);
      }
    }

    return unresolved;
  }, [localTemplate, availableVariables]);

  // Compute resolved text client-side for preview (single-pass to avoid prefix collisions)
  const resolvedPreview = useMemo(() => {
    const valueMap = new Map(availableVariables.map(v => [v.name, v.value]));
    return localTemplate.replace(/@(\w+)/g, (match, name) => valueMap.get(name) ?? match);
  }, [localTemplate, availableVariables]);

  // Sync resolved text to outputText so downstream nodes can read it before execution
  useEffect(() => {
    const valueMap = new Map(availableVariables.map(v => [v.name, v.value]));
    const resolved = nodeData.template.replace(/@(\w+)/g, (match, name) => valueMap.get(name) ?? match);
    const outputValue = resolved || null;
    if (outputValue !== nodeData.outputText) {
      updateNodeData(id, { outputText: outputValue });
    }
  }, [nodeData.template, availableVariables, id, updateNodeData, nodeData.outputText]);

  const highlightRef = useRef<HTMLDivElement>(null);

  // Sync highlight overlay scroll with textarea
  const handleScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  // Build highlighted text with blue for text vars, green for image vars, red for unresolved
  const highlightedContent = useMemo((): ReactNode[] => {
    const varMap = new Map(availableVariables.map(v => [v.name, v]));
    const pattern = /@(\w+)/g;
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    const matches = localTemplate.matchAll(pattern);
    for (const match of matches) {
      const idx = match.index!;
      if (idx > lastIndex) {
        parts.push(localTemplate.slice(lastIndex, idx));
      }
      const variable = varMap.get(match[1]);
      let bgClass = "bg-red-400/50"; // unresolved
      if (variable) {
        bgClass = variable.variableType === "image" ? "bg-emerald-400/30" : "bg-blue-400/30";
      }
      parts.push(
        <mark key={idx} className={`${bgClass} text-transparent rounded-sm px-0.5 -mx-0.5 py-0.5`}>{match[0]}</mark>
      );
      lastIndex = idx + match[0].length;
    }
    if (lastIndex < localTemplate.length) {
      parts.push(localTemplate.slice(lastIndex));
    }
    return parts;
  }, [localTemplate, availableVariables]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    if (localTemplate !== nodeData.template) {
      updateNodeData(id, { template: localTemplate });
    }
    // Close autocomplete on blur
    setTimeout(() => closeAutocomplete(), 200);
  }, [id, localTemplate, nodeData.template, updateNodeData, closeAutocomplete]);

  return (
    <>
      <BaseNode
        id={id}
        selected={selected}
        fullBleed
      >
        {/* Text input handle */}
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          data-handletype="text"
          style={{ top: "40%", zIndex: 10 }}
        />

        {/* Image input handle - for image variables */}
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          data-handletype="image"
          style={{ top: "60%", zIndex: 10 }}
        />

        {/* Template textarea with highlight overlay for @variables */}
        <div className="relative w-full h-full">
          {/* Highlight overlay - blue for resolved, red for unresolved @vars */}
          {highlightedContent.length > 0 && (
            <div
              ref={highlightRef}
              className={`absolute inset-0 p-3 text-xs leading-relaxed text-transparent bg-neutral-800 rounded-lg overflow-hidden whitespace-pre-wrap break-words pointer-events-none ${availableVariables.length > 0 || unresolvedVars.length > 0 ? "pb-7" : ""}`}
              aria-hidden="true"
            >
              {highlightedContent}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={localTemplate}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
            placeholder="Type @ to insert variables..."
            className={`nodrag nopan nowheel relative w-full h-full p-3 text-xs leading-relaxed text-neutral-100 rounded-lg resize-none focus:outline-none placeholder:text-neutral-500 ${highlightedContent.length > 0 ? "bg-transparent" : "bg-neutral-800"} ${availableVariables.length > 0 || unresolvedVars.length > 0 ? "pb-7" : ""}`}
            title={resolvedPreview ? `Preview: ${resolvedPreview}` : undefined}
          />

          {/* Autocomplete dropdown */}
          {showAutocomplete && filteredAutocompleteVars.length > 0 && (
            <div
              className="nodrag nopan nowheel absolute z-20 bg-neutral-800 border border-neutral-600 rounded shadow-xl max-h-40 overflow-y-auto"
              style={{
                top: autocompletePosition.top,
                left: autocompletePosition.left,
              }}
            >
              {filteredAutocompleteVars.map((variable, index) => (
                <button
                  key={variable.nodeId}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleAutocompleteSelect(variable.name);
                  }}
                  className={`w-full px-3 py-2 text-left text-[11px] flex flex-col gap-0.5 transition-colors ${
                    index === selectedAutocompleteIndex
                      ? "bg-neutral-700 text-neutral-100"
                      : "text-neutral-300 hover:bg-neutral-700"
                  }`}
                >
                  <div className={`font-medium ${variable.variableType === "image" ? "text-emerald-400" : "text-blue-400"}`}>@{variable.name}</div>
                  <div className="text-neutral-500 truncate max-w-[200px]">
                    {variable.variableType === "image" ? "(image)" : variable.value || "(empty)"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer - available vars + unresolved warning */}
        {(availableVariables.length > 0 || unresolvedVars.length > 0) && (
          <div className="absolute bottom-0 left-0 right-0 z-10 px-3 py-1.5 bg-neutral-900/90 rounded-b-lg text-[10px] pointer-events-none flex items-center justify-between gap-2">
            <span className="text-neutral-500 truncate">
              {availableVariables.length > 0 ? `Available: ${availableVariables.map(v => `@${v.name}`).join(', ')}` : ''}
            </span>
            {unresolvedVars.length > 0 && (
              <span className="text-red-400 whitespace-nowrap">
                {unresolvedVars.length} {unresolvedVars.length === 1 ? 'var' : 'vars'} missing
              </span>
            )}
          </div>
        )}

        {/* Text output handle */}
        <Handle
          type="source"
          position={Position.Right}
          id="text"
          data-handletype="text"
          style={{ zIndex: 10 }}
        />
      </BaseNode>
    </>
  );
}
