import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { Socket, SocketColumn, assignSocketRows, socketRowCount } from "../Socket";

const mockConnections = vi.fn<(args: { handleType?: string; handleId?: string }) => unknown[]>(() => []);

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    useNodeConnections: (args: { handleType?: string; handleId?: string }) => mockConnections(args),
  };
});

function wrap(ui: React.ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe("Socket", () => {
  beforeEach(() => {
    mockConnections.mockReset();
    mockConnections.mockReturnValue([]);
  });

  it("renders a target handle with the id, type and geometry of its row", () => {
    const { container } = wrap(<Socket nodeId="n1" side="left" row={1} spec={{ id: "image", type: "image", label: "Image" }} />);
    const handle = container.querySelector('[data-handletype="image"]') as HTMLElement;
    expect(handle).toHaveAttribute("data-handleid", "image");
    expect(handle.className).toContain("target");
    expect(handle.className).toContain("socket");
    expect(handle.style.top).toBe("40px");
    expect(handle.style.left).toBe("-15px");
    expect(handle.style.transform).toBe("none");
    expect(handle).not.toHaveAttribute("data-connected");
    const hole = handle.querySelector("[data-socket-hole]") as SVGCircleElement;
    expect(hole.getAttribute("fill")).toBe("var(--color-canvas-bg)");
    expect(hole.getAttribute("stroke-opacity")).toBe("0.6");
  });

  it("mirrors on the right and fills the hole when connected", () => {
    mockConnections.mockReturnValue([{}]);
    const { container } = wrap(<Socket nodeId="n1" side="right" row={0} spec={{ id: "video", type: "video" }} />);
    const handle = container.querySelector('[data-handletype="video"]') as HTMLElement;
    expect(handle.className).toContain("source");
    expect(handle.style.right).toBe("-15px");
    expect(handle.style.transform).toBe("scaleX(-1)");
    expect(handle).toHaveAttribute("data-connected", "true");
    expect(mockConnections).toHaveBeenCalledWith({ id: "n1", handleType: "source", handleId: "video" });
    const hole = handle.querySelector("[data-socket-hole]") as SVGCircleElement;
    expect(hole.getAttribute("fill")).toBe("currentColor");
  });

  it("keeps a hidden socket in the DOM, unconnectable and invisible", () => {
    const { container } = wrap(<Socket nodeId="n1" side="left" row={0} spec={{ id: "image-0", type: "image", hidden: true }} />);
    const handle = container.querySelector('[data-handleid="image-0"]') as HTMLElement;
    expect(handle).toBeInTheDocument();
    expect(handle.className).toContain("socket-hidden");
    expect(handle.style.width).toBe("0px");
    expect(handle.style.opacity).toBe("0");
    expect(handle.querySelector("svg")).toBeNull();
  });

  it("dims placeholders and forwards data-tutorial", () => {
    const { container } = wrap(
      <Socket nodeId="n1" side="left" row={0} spec={{ id: "text", type: "text", placeholder: true, dataTutorial: "generate-text-input-handle" }} />
    );
    const handle = container.querySelector('[data-handletype="text"]') as HTMLElement;
    expect(handle.className).toContain("socket-placeholder");
    expect(handle).toHaveAttribute("data-tutorial", "generate-text-input-handle");
  });

  it("shows the label beside the socket only when asked", () => {
    const { rerender } = wrap(<Socket nodeId="n1" side="left" row={0} spec={{ id: "text", type: "text", label: "Prompt" }} />);
    expect(screen.getByText("Prompt")).toHaveStyle({ opacity: "0" });
    rerender(
      <ReactFlowProvider>
        <Socket nodeId="n1" side="left" row={0} spec={{ id: "text", type: "text", label: "Prompt" }} showLabel />
      </ReactFlowProvider>
    );
    expect(screen.getByText("Prompt")).toHaveStyle({ opacity: "1" });
  });
});

describe("SocketColumn", () => {
  it("stacks visible sockets at the pitch and parks hidden ones on the previous row", () => {
    const sockets = [
      { id: "image", type: "image" as const },
      { id: "image-0", type: "image" as const, hidden: true },
      { id: "text", type: "text" as const },
      { id: "audio", type: "audio" as const },
    ];
    expect(assignSocketRows(sockets)).toEqual([0, 0, 1, 2]);
    expect(socketRowCount(sockets)).toBe(3);
    const { container } = wrap(<SocketColumn nodeId="n1" side="left" sockets={sockets} />);
    const tops = Array.from(container.querySelectorAll(".socket:not(.socket-hidden)")).map((el) => (el as HTMLElement).style.top);
    expect(tops).toEqual(["10px", "40px", "70px"]);
  });

  it("honours explicit rows", () => {
    expect(assignSocketRows([{ id: "a", type: "text", row: 2 }, { id: "b", type: "text" }])).toEqual([2, 3]);
    expect(socketRowCount([])).toBe(0);
  });
});

describe("Socket outline", () => {
  it("draws the card border colour when the node is idle", () => {
    const { container } = wrap(<Socket nodeId="n1" side="left" row={0} spec={{ id: "image", type: "image" }} />);
    const outline = container.querySelector("[data-socket-outline]") as SVGPathElement;
    expect(outline.getAttribute("class")).toContain("stroke-card-border");
    expect(container.querySelector("[data-socket-ring]")).toBeNull();
  });

  it("continues the selection outline and ring around the swell", () => {
    const { container } = wrap(<Socket nodeId="n1" side="left" row={0} spec={{ id: "image", type: "image" }} outline="selected" />);
    const outline = container.querySelector("[data-socket-outline]") as SVGPathElement;
    expect(outline.getAttribute("stroke")).toBe("var(--color-selection)");
    const ring = container.querySelector("[data-socket-ring]") as SVGPathElement;
    expect(ring.getAttribute("stroke-width")).toBe("5");
    expect(ring.getAttribute("stroke")).toBe("color-mix(in srgb, var(--color-selection) 40%, var(--color-canvas-bg))");
  });

  it("uses the error colour with no ring", () => {
    const { container } = wrap(<Socket nodeId="n1" side="right" row={0} spec={{ id: "image", type: "image" }} outline="error" />);
    expect((container.querySelector("[data-socket-outline]") as SVGPathElement).getAttribute("stroke")).toBe("var(--color-error)");
    expect(container.querySelector("[data-socket-ring]")).toBeNull();
  });
});
