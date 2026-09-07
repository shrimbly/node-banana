import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ImageInputNode } from "@/components/nodes/ImageInputNode";
import { AudioInputNode } from "@/components/nodes/AudioInputNode";
import { VideoInputNode } from "@/components/nodes/VideoInputNode";
import { AnnotationNode } from "@/components/nodes/AnnotationNode";

const state = vi.hoisted(() => ({ workflowLifecycleId: 0, updateNodeData: vi.fn() }));
vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
}));
vi.mock("@/store/annotationStore", () => ({ useAnnotationStore: () => vi.fn() }));
vi.mock("@/hooks/useCommentNavigation", () => ({ useCommentNavigation: vi.fn() }));
vi.mock("@/hooks/useAdaptiveImageSrc", () => ({ useAdaptiveImageSrc: (value: string) => value }));
vi.mock("@/hooks/useVideoBlobUrl", () => ({ useVideoBlobUrl: () => null }));
vi.mock("@/hooks/useAudioVisualization", () => ({
  useAudioVisualization: () => ({ waveformData: null, isLoading: false }),
}));
vi.mock("@/hooks/useAudioPlayback", () => ({
  useAudioPlayback: () => ({ audioRef: { current: null }, formatTime: () => "0:00" }),
}));
vi.mock("@/components/nodes/NodeShell", () => ({
  NodeShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/nodes/ui", () => ({
  ControlsCard: () => null, SummaryValues: () => null, ScrubRow: () => null, formatTime: () => "0:00",
}));

class DeferredReader {
  static instances: DeferredReader[] = [];
  onload?: (event: { target: { result: string } }) => void;
  constructor() { DeferredReader.instances.push(this); }
  readAsDataURL() {}
  finish(value = "data:media;base64,bmV3") { this.onload?.({ target: { result: value } }); }
}
class DeferredMetadata {
  static instances: DeferredMetadata[] = [];
  onload?: () => void;
  onloadedmetadata?: () => void;
  onerror?: () => void;
  width = 100;
  height = 80;
  duration = 3;
  src = "";
  constructor() { DeferredMetadata.instances.push(this); }
  finish() { this.onload?.(); this.onloadedmetadata?.(); }
}

const props = {
  id: "shared-node-id", selected: false, isConnectable: true, positionAbsoluteX: 0,
  positionAbsoluteY: 0, zIndex: 0, dragging: false, deletable: true, selectable: true,
};
const cases = [
  { name: "image", mime: "image/png", render: () => <ImageInputNode {...props} type="imageInput" data={{ image: null, filename: null, dimensions: null }} /> },
  { name: "audio", mime: "audio/wav", render: () => <AudioInputNode {...props} type="audioInput" data={{ audioFile: null, filename: null, duration: null, format: null }} /> },
  { name: "video", mime: "video/mp4", render: () => <VideoInputNode {...props} type="videoInput" data={{ video: null, filename: null, duration: null, dimensions: null, format: null }} /> },
  { name: "annotation", mime: "image/png", render: () => <AnnotationNode {...props} type="annotation" data={{ sourceImage: null, outputImage: null, annotations: [] }} /> },
];
let videos: HTMLVideoElement[];
function finishMetadata() {
  DeferredMetadata.instances.forEach((item) => item.finish());
  videos.forEach((video) => video.dispatchEvent(new Event("loadedmetadata")));
}

beforeEach(() => {
  state.workflowLifecycleId = 0;
  state.updateNodeData.mockReset();
  DeferredReader.instances = [];
  DeferredMetadata.instances = [];
  videos = [];
  vi.stubGlobal("FileReader", DeferredReader);
  vi.stubGlobal("Image", DeferredMetadata);
  vi.stubGlobal("Audio", DeferredMetadata);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: async () => new Blob() }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:metadata");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (tag === "video") videos.push(element as HTMLVideoElement);
    return element;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(cases)("$name upload ownership", (testCase) => {
  function startUpload() {
    const result = render(testCase.render());
    const input = result.container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["media"], "new-file", { type: testCase.mime })] } });
    return { ...result, input };
  }

  it("commits a current upload", () => {
    startUpload();
    DeferredReader.instances[0].finish();
    finishMetadata();
    expect(state.updateNodeData).toHaveBeenCalledOnce();
    expect(state.updateNodeData.mock.calls[0][0]).toBe("shared-node-id");
  });

  it("ignores a file read completed after switching or replacing workflows", () => {
    startUpload();
    state.workflowLifecycleId += 1;
    DeferredReader.instances[0].finish();
    finishMetadata();
    expect(state.updateNodeData).not.toHaveBeenCalled();
  });

  it("ignores an upload after its node unmounts", () => {
    const { unmount } = startUpload();
    unmount();
    DeferredReader.instances[0].finish();
    finishMetadata();
    expect(state.updateNodeData).not.toHaveBeenCalled();
  });

  it("does not let a slower previous upload replace the latest selection", () => {
    const { input } = startUpload();
    fireEvent.change(input, { target: { files: [new File(["latest"], "latest-file", { type: testCase.mime })] } });
    DeferredReader.instances[1].finish("data:media;base64,bGF0ZXN0");
    finishMetadata();
    DeferredReader.instances[0].finish();
    finishMetadata();
    // Only the second reader should reach metadata extraction/the store.
    expect(DeferredMetadata.instances.length).toBeLessThanOrEqual(1);
    expect(state.updateNodeData.mock.calls.every(([, data]) =>
      Object.values(data).includes("data:media;base64,bGF0ZXN0")
    )).toBe(true);
    expect(state.updateNodeData).toHaveBeenCalled();
  });

  if (testCase.name !== "annotation") {
    it("ignores metadata completed after a workflow switch", () => {
      startUpload();
      DeferredReader.instances[0].finish();
      state.workflowLifecycleId += 1;
      finishMetadata();
      expect(state.updateNodeData).not.toHaveBeenCalled();
      if (testCase.name === "video") expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:metadata");
    });
  }
});

describe("audio file references", () => {
  const audioNode = () => <AudioInputNode {...props} type="audioInput" data={{
    audioFile: "data:audio/wav;base64,b2xk", audioFileRef: "old.wav",
    filename: "old.wav", duration: 1, format: "audio/wav",
  }} />;

  it.each(["metadata", "error"])("clears the saved reference when replacing audio (%s)", async (event) => {
    const { container } = render(audioNode());
    await act(async () => {});
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["new"], "new.wav", { type: "audio/wav" })] },
    });
    DeferredReader.instances[0].finish("data:audio/wav;base64,bmV3");
    if (event === "metadata") DeferredMetadata.instances[0].finish();
    else DeferredMetadata.instances[0].onerror?.();
    expect(state.updateNodeData).toHaveBeenCalledWith("shared-node-id", expect.objectContaining({
      audioFile: "data:audio/wav;base64,bmV3", audioFileRef: undefined,
    }));
  });

  it("clears the saved reference on removal and cancels a pending replacement", async () => {
    const { container, getByRole } = render(audioNode());
    await act(async () => {});
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["new"], "new.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(getByRole("button", { name: "Remove audio" }));
    DeferredReader.instances[0].finish();
    finishMetadata();
    expect(state.updateNodeData).toHaveBeenCalledExactlyOnceWith("shared-node-id", expect.objectContaining({
      audioFile: null, audioFileRef: undefined,
    }));
  });
});
