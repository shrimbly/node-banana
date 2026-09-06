"use client";

import React, { useMemo, useState } from "react";

import { ComfyWordmark } from "@/components/icons/ComfyWordmark";
import { ComfyAppParameters } from "@/components/nodes/ComfyAppParameters";
import type { ComfyAppInput, ComfyAppOutput, ComfyAppParam } from "@/lib/comfy/types";
import { HANDLE_TYPE_COLORS } from "@/lib/edges/colors";

/**
 * The node this dialog is about to build, drawn as it will appear.
 *
 * The picks on the left are a list of bindings; what the user is actually
 * deciding is the shape of a node — how many handles it carries, what they are
 * called, which knobs sit under it. This says that in the only language that
 * answers it, and updates as they choose.
 *
 * Deliberately a replica rather than the node itself: the real one is a React
 * Flow node wired to the workflow store, and standing an instance of it up here
 * would mean faking a canvas. The settings are the exception — they are already
 * a plain controlled component, so the real one is used and the values are live.
 */

/** Matches `.react-flow__handle[data-handletype]` in globals.css. */
const HANDLE_FILL: Record<string, string> = HANDLE_TYPE_COLORS;

/** Evenly space n handles down an edge — the node's own rule. */
const handleTop = (index: number, total: number): string =>
  `${((index + 1) / (total + 1)) * 100}%`;

interface ComfyNodePreviewProps {
  name: string;
  source: "blueprint" | "upload";
  nodeCount: number;
  inputs: ComfyAppInput[];
  params: ComfyAppParam[];
  outputs: ComfyAppOutput[];
}

export function ComfyNodePreview({
  name,
  source,
  nodeCount,
  inputs,
  params,
  outputs,
}: ComfyNodePreviewProps) {
  // Seeded from the defaults, exactly as the node seeds itself on attach —
  // otherwise every dropdown reads "Default (…)", which is a state the real
  // node is never in. Edits are kept but not saved: nothing typed in a preview
  // is, and a control that cannot be moved reads as a broken one.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const values = useMemo(() => {
    const seeded: Record<string, unknown> = {};
    for (const param of params) {
      if (param.default !== undefined) seeded[param.id] = param.default;
    }
    return { ...seeded, ...edits };
  }, [params, edits]);

  return (
    <div className="h-full rounded-well bg-well ring-1 ring-inset ring-black/40 overflow-auto flex justify-center p-6">
      {/* The node sits at its real width, so the preview is a measurement and
          not an impression.

          Centred with `my-auto` rather than `items-center`: a centred flex
          child in a scroll container has its overflowing top cut off and
          unreachable, and a node with every widget exposed overflows easily. */}
      <div className="w-[260px] shrink-0 my-auto">
        {/* The canvas draws the title above the node, not inside it. */}
        <div className="flex items-center gap-1.5 mb-1.5 px-0.5">
          <ComfyWordmark className="h-3 w-auto shrink-0 text-neutral-400" />
          <span className="text-[11px] text-neutral-400 truncate" title={name}>
            {name || "Untitled"}
          </span>
        </div>

        <div className="relative bg-card rounded-controls shadow-lg">
          <Handles inputs={inputs} outputs={outputs} />

          <div className="rounded-t-controls border border-b-0 border-card-border px-3 pb-4">
            <div className="flex items-center gap-2 pt-2 pb-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-neutral-200 truncate">
                  {source === "blueprint" ? "Blueprint" : "App workflow"}
                </p>
                <p className="text-[9px] text-neutral-500 truncate">
                  {nodeCount} node{nodeCount === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div className="h-[92px] rounded-md bg-neutral-900/60 flex items-center justify-center">
              <span className="text-[10px] text-neutral-600">No output yet</span>
            </div>
          </div>

          {/* Always open here. Collapsed, the one thing this view exists to
              show would be a chevron. */}
          <div className="bg-panel rounded-b-controls">
            <div className="w-full flex items-center justify-center gap-1 py-1 text-neutral-500">
              <span className="text-[10px]">Settings</span>
              <svg
                className="w-3 h-3 rotate-180"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
            <div className="px-3 pb-3 rounded-b-controls">
              {params.length > 0 ? (
                <ComfyAppParameters params={params} values={values} onChange={setEdits} />
              ) : (
                <span className="text-[9px] text-neutral-500">
                  This workflow exposes no settings
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Connection points, on the edges they will really sit on. */
function Handles({
  inputs,
  outputs,
}: {
  inputs: ComfyAppInput[];
  outputs: ComfyAppOutput[];
}) {
  return (
    <>
      {inputs.map((input, index) => (
        <Dot
          key={input.id}
          side="left"
          top={handleTop(index, inputs.length)}
          type={input.type}
          label={input.label}
        />
      ))}
      {outputs.map((output, index) => (
        <Dot
          key={output.id}
          side="right"
          top={handleTop(index, outputs.length)}
          type={output.type}
          label={output.label}
        />
      ))}
    </>
  );
}

function Dot({
  side,
  top,
  type,
  label,
}: {
  side: "left" | "right";
  top: string;
  type: string;
  label: string;
}) {
  const dot = (
    <span
      className="block w-[14px] h-[14px] rounded-full border-2 border-white shrink-0"
      style={{
        background: HANDLE_FILL[type] ?? HANDLE_FILL.image,
        boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
      }}
    />
  );
  // Outside the node, so a long name never squeezes the body.
  const text = (
    <span
      className="text-[9px] text-neutral-400 whitespace-nowrap max-w-[96px] truncate"
      title={label}
    >
      {label}
    </span>
  );

  return (
    <div
      className="absolute z-10 flex items-center gap-1.5"
      style={{
        top,
        transform: "translateY(-50%)",
        // Anchored by the edge the dot sits on, so the label grows away from
        // the node rather than pushing the dot into it.
        ...(side === "left"
          ? { right: "calc(100% - 7px)" }
          : { left: "calc(100% - 7px)" }),
      }}
    >
      {side === "left" ? (
        <>
          {text}
          {dot}
        </>
      ) : (
        <>
          {dot}
          {text}
        </>
      )}
    </div>
  );
}
