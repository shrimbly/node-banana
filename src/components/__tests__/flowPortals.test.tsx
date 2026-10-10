import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const flow = vi.hoisted(() => ({ domNode: null as HTMLElement | null }));
vi.mock("@xyflow/react", () => ({
  useStore: (selector: (state: { domNode: HTMLElement | null }) => unknown) => selector({ domNode: flow.domNode }),
}));

import { EdgeLabelRenderer, ViewportPortal } from "@/components/flowPortals";

function canvas() {
  const domNode = document.createElement("div");
  domNode.innerHTML = '<div class="react-flow__viewport"><div class="react-flow__edgelabel-renderer"></div><div class="react-flow__node"></div><div class="react-flow__viewport-portal"></div></div>';
  document.body.appendChild(domNode);
  return domNode;
}

describe("flow portals", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    flow.domNode = canvas();
  });

  it("render into React Flow's own containers", () => {
    render(<><ViewportPortal><span data-testid="group" /></ViewportPortal><EdgeLabelRenderer><span data-testid="label" /></EdgeLabelRenderer></>);
    expect(flow.domNode!.querySelector(".react-flow__viewport-portal [data-testid=group]")).not.toBeNull();
    expect(flow.domNode!.querySelector(".react-flow__edgelabel-renderer [data-testid=label]")).not.toBeNull();
  });

  it("search the canvas once, not on every store update", () => {
    const search = vi.spyOn(flow.domNode!, "querySelector");
    const { rerender } = render(<ViewportPortal><span /></ViewportPortal>);
    for (let i = 0; i < 5; i++) rerender(<ViewportPortal><span data-index={i} /></ViewportPortal>);
    expect(search.mock.calls.filter(([selector]) => selector === ".react-flow__viewport-portal")).toHaveLength(1);
  });

  it("find the container again once it has been replaced", () => {
    render(<ViewportPortal><span /></ViewportPortal>);
    const viewport = flow.domNode!.querySelector(".react-flow__viewport")!;
    viewport.querySelector(".react-flow__viewport-portal")!.remove();
    const replacement = document.createElement("div");
    replacement.className = "react-flow__viewport-portal";
    viewport.appendChild(replacement);
    render(<ViewportPortal><span data-testid="moved" /></ViewportPortal>);
    expect(replacement.querySelector("[data-testid=moved]")).not.toBeNull();
  });

  it("render nothing before the canvas exists", () => {
    flow.domNode = null;
    const { container } = render(<EdgeLabelRenderer><span data-testid="label" /></EdgeLabelRenderer>);
    expect(container.innerHTML).toBe("");
  });
});
