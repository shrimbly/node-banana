import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { requestSave, useSaveRequestStore } from "@/store/saveRequestStore";
import { createClip } from "@/lib/stitch/timeline";
import type { StitchDraft } from "@/lib/stitch/draft";
import type { WorkflowNode } from "@/types";
import { openStitchEditor } from "../openStitchEditor";
import { useEditorLifecycle } from "../useEditorLifecycle";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const editor = () => useStitchEditorStore.getState();
const wf = () => useWorkflowStore.getState();
const draft: StitchDraft = {
  timeline: [createClip({ kind: "asset", assetId: "a1" }, { id: "v1" })],
  audioClips: [],
  legacyAudio: { curve: [], muted: false },
  loopCount: 1,
  sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true },
};

beforeEach(() => {
  editor().close();
  useSaveRequestStore.setState({ request: null });
  useWorkflowStore.setState({
    nodes: [{ id: "s1", type: "videoStitch", position: { x: 0, y: 0 }, data: { clips: [], loopCount: 1 } } as unknown as WorkflowNode],
    edges: [],
  });
});
afterEach(() => editor().close());

describe("useEditorLifecycle", () => {
  it("closes a node session when the canvas is replaced", () => {
    openStitchEditor("s1");
    renderHook(() => useEditorLifecycle());
    act(() => useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 }));
    expect(editor().isOpen).toBe(false);
  });

  it("leaves an edit project's session alone: a canvas replaced and a workflow save are not its business", () => {
    editor().openEdit({ editId: "ed0123456789ab", draft });
    editor().apply((d) => ({ ...d, loopCount: 2 }));
    renderHook(() => useEditorLifecycle());
    act(() => useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1, nodes: [] }));
    act(() => requestSave("menu"));
    expect(editor().isOpen).toBe(true);
    expect(editor().editId).toBe("ed0123456789ab");
    expect(editor().initial).toBe(draft);
  });
});
