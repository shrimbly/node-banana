"use client";

import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { Dialog, DialogBody, DialogButton, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { PromptNodeData } from "@/types";
import { ControlsCard, HeightGrip, SummaryValues, type SocketSpec } from "./ui";

type PromptNodeType = Node<PromptNodeData, "prompt">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Text" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Text", dataTutorial: "prompt-output-handle" }];
const DEFAULT_HEIGHT = 160;

export function PromptNode({ id, data, selected }: NodeProps<PromptNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);

  // Local state for prompt to prevent cursor jumping during typing
  const [localPrompt, setLocalPrompt] = useState(nodeData.prompt);
  const [isEditing, setIsEditing] = useState(false);

  // Variable naming dialog state
  const [showVarDialog, setShowVarDialog] = useState(false);
  const [varNameInput, setVarNameInput] = useState(nodeData.variableName || "");

  // Check if this node has any incoming text connections
  const hasIncomingTextConnection = useMemo(() => {
    return (edges ?? []).some((edge) => edge.target === id && edge.targetHandle === "text");
  }, [edges, id]);

  // Track the last received text from connected LLM node to detect when it changes
  const lastReceivedTextRef = useRef<string | null>(null);

  // Get connected text input and update prompt when LLM output changes
  useEffect(() => {
    if (hasIncomingTextConnection) {
      const { text } = getConnectedInputs(id);
      // Only update if the incoming text changed (LLM node ran again)
      if (text !== null && text !== lastReceivedTextRef.current) {
        lastReceivedTextRef.current = text;
        updateNodeData(id, { prompt: text });
      }
    } else {
      // Clear tracking when connection is removed
      lastReceivedTextRef.current = null;
    }
  }, [hasIncomingTextConnection, id, getConnectedInputs, updateNodeData]);

  // Sync from props when not actively editing
  useEffect(() => {
    if (!isEditing) {
      setLocalPrompt(nodeData.prompt);
    }
  }, [nodeData.prompt, isEditing]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setLocalPrompt(e.target.value);
    },
    []
  );

  const handleFocus = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    if (localPrompt !== nodeData.prompt) {
      updateNodeData(id, { prompt: localPrompt });
    }
  }, [id, localPrompt, nodeData.prompt, updateNodeData]);

  const handleSaveVariableName = useCallback(() => {
    updateNodeData(id, { variableName: varNameInput || undefined });
    setShowVarDialog(false);
  }, [id, varNameInput, updateNodeData]);

  const handleClearVariableName = useCallback(() => {
    setVarNameInput("");
    updateNodeData(id, { variableName: undefined });
    setShowVarDialog(false);
  }, [id, updateNodeData]);

  const handleVariableNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Allow only alphanumeric and underscore, max 30 chars
    const sanitized = e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 30);
    setVarNameInput(sanitized);
  }, []);

  const mediaHeight = nodeData.mediaHeight ?? DEFAULT_HEIGHT;
  const charCount = (localPrompt ?? "").length;

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        media={{ kind: "fixed", height: mediaHeight }}
        inputs={INPUT_SOCKETS}
        outputs={OUTPUT_SOCKETS}
        controls={
          <ControlsCard
            id={id}
            summary={{
              title: (
                <button
                  onClick={() => setShowVarDialog(true)}
                  className="nodrag nopan text-node text-blue-400 hover:text-blue-300 transition-colors"
                  title="Set variable name"
                >
                  {nodeData.variableName ? `@${nodeData.variableName}` : "Add variable"}
                </button>
              ),
              values: <SummaryValues items={[`${charCount} chars`, nodeData.isOptional ? "optional" : null]} />,
            }}
          />
        }
      >
        <textarea
          value={localPrompt}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={hasIncomingTextConnection ? "Text from connected node (editable)..." : nodeData.isOptional ? "Optional prompt (leave empty to skip)..." : "Describe what to generate..."}
          className="nodrag nopan nowheel absolute inset-0 w-full h-full p-3 pb-4 text-xs leading-relaxed text-neutral-100 bg-neutral-900/40 resize-none focus:outline-none placeholder:text-neutral-500"
        />
        <HeightGrip height={mediaHeight} onChange={(h) => updateNodeData(id, { mediaHeight: h })} />
      </NodeShell>

      {/* Variable Naming Dialog - on the dialog tier, in a body portal */}
      <Dialog open={showVarDialog} onClose={() => setShowVarDialog(false)} size="xs" portal>
          <DialogHeader compact closeButton={false}>
            <DialogTitle compact>Set Variable Name</DialogTitle>
            <DialogDescription>Use this prompt as a variable in PromptConstructor nodes</DialogDescription>
          </DialogHeader>
          <DialogBody compact>
            <div className="mb-1">
              <label className="block text-xs text-neutral-300 mb-1">Variable name</label>
              <input
                type="text"
                value={varNameInput}
                onChange={handleVariableNameChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && varNameInput) {
                    handleSaveVariableName();
                  }
                }}
                placeholder="e.g. color, style, subject"
                className="w-full px-2.5 py-1.5 text-[13px] text-neutral-100 bg-well border border-card-border rounded-well focus:outline-none focus:border-selection"
                autoFocus
              />
              {varNameInput && (
                <div className="mt-2 text-xs text-blue-400">
                  Preview: <span className="font-mono">@{varNameInput}</span>
                </div>
              )}
            </div>
          </DialogBody>
          <DialogFooter compact>
            {nodeData.variableName && (
              <DialogButton compact variant="danger" onClick={handleClearVariableName} className="mr-auto">
                Clear
              </DialogButton>
            )}
            <DialogButton compact variant="ghost" onClick={() => setShowVarDialog(false)}>
              Cancel
            </DialogButton>
            <DialogButton compact variant="primary" onClick={handleSaveVariableName} disabled={!varNameInput}>
              Save
            </DialogButton>
          </DialogFooter>
      </Dialog>
    </>
  );
}
