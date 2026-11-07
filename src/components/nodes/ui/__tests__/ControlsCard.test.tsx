import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { ControlsCard, SummaryValues } from "../ControlsCard";

const flow = { wrapper: ReactFlowProvider };

describe("ControlsCard", () => {
  it("renders the summary only, without a toggle, when there is no panel", () => {
    render(<ControlsCard id="n1" summary={{ title: "Nano Banana Pro" }} />);
    expect(screen.getByText("Nano Banana Pro")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("toggles via the chevron and the row, with aria wiring", () => {
    const onToggle = vi.fn();
    render(
      <ControlsCard id="n1" summary={{ title: "Model" }} expanded={false} onToggle={onToggle}>
        <div>panel</div>
      </ControlsCard>
    );
    const button = screen.getByRole("button", { name: "Expand settings" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", "params-n1");
    expect(document.getElementById("params-n1")).toHaveTextContent("panel");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Model"));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("labels the chevron for collapse when expanded", () => {
    render(
      <ControlsCard id="n1" summary={{ title: "Model" }} expanded onToggle={() => {}}>
        <div>panel</div>
      </ControlsCard>
    );
    expect(screen.getByRole("button", { name: "Collapse settings" })).toHaveAttribute("aria-expanded", "true");
  });

  it("SummaryValues drops empty items and separates the rest", () => {
    render(<SummaryValues items={["16:9", null, "", "1K"]} />);
    expect(screen.getByText("16:9")).toBeInTheDocument();
    expect(screen.getByText("1K")).toBeInTheDocument();
    expect(screen.getAllByText("·")).toHaveLength(1);
  });

  it("SummaryValues' truncated line keeps a space each side of its dots, also with the dots left out", () => {
    const { container } = render(<SummaryValues truncate items={["0:15", "1 crossfade", "1 gap", "loop 1×"]} />);
    const line = container.firstElementChild as HTMLElement;
    expect(line.textContent).toBe("0:15 · 1 crossfade · 1 gap · loop 1×");
    expect(line).toHaveAttribute("title", "0:15 · 1 crossfade · 1 gap · loop 1×");
    // What a screen reader reads: the dots are hidden, the words stay apart
    const spoken = line.cloneNode(true) as HTMLElement;
    spoken.querySelectorAll("[aria-hidden]").forEach((dot) => dot.remove());
    expect(spoken.textContent!.replace(/\s+/g, " ")).toBe("0:15 1 crossfade 1 gap loop 1×");
  });
});

describe("ControlsCard sizing", () => {
  const sizing = (width?: number) => ({ nodeWidth: 300, width, onWidthChange: vi.fn() });

  it("has no grips and no explicit width without sizing", () => {
    const { container } = render(<ControlsCard id="n1" summary={{ title: "Model" }} />);
    expect(container.querySelector("[data-width-grip]")).toBeNull();
    const card = container.querySelector("[data-controls-card]") as HTMLElement;
    expect(card.style.width).toBe("");
  });

  it("applies an explicit width and lifts the cap", () => {
    const { container } = render(<ControlsCard id="n1" summary={{ title: "Model" }} sizing={sizing(500)} />, flow);
    const card = container.querySelector("[data-controls-card]") as HTMLElement;
    expect(card.style.width).toBe("500px");
    expect(card.style.maxWidth).toBe("none");
    expect(container.querySelectorAll("[data-width-grip]")).toHaveLength(2);
  });

  it("dragging the right grip widens symmetrically from the automatic width", () => {
    const s = sizing();
    const { container } = render(<ControlsCard id="n1" summary={{ title: "Model" }} sizing={s} />, flow);
    const grip = container.querySelector('[data-width-grip="right"]') as HTMLElement;
    grip.setPointerCapture = vi.fn();
    grip.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 120, pointerId: 1 });
    // 300 − 24 = 276 automatic, + 2 × 20
    expect(s.onWidthChange).toHaveBeenLastCalledWith(316);
    fireEvent.pointerUp(grip, { pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 200, pointerId: 1 });
    expect(s.onWidthChange).toHaveBeenCalledTimes(1);
  });

  it("dragging the left grip outward widens too, and clamps at the minimum", () => {
    const s = sizing(200);
    const { container } = render(<ControlsCard id="n1" summary={{ title: "Model" }} sizing={s} />, flow);
    const grip = container.querySelector('[data-width-grip="left"]') as HTMLElement;
    grip.setPointerCapture = vi.fn();
    grip.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 90, pointerId: 1 });
    expect(s.onWidthChange).toHaveBeenLastCalledWith(220);
    fireEvent.pointerMove(grip, { clientX: 400, pointerId: 1 });
    expect(s.onWidthChange).toHaveBeenLastCalledWith(160);
  });

  it("double-clicking a grip resets to follow the node", () => {
    const s = sizing(500);
    const { container } = render(<ControlsCard id="n1" summary={{ title: "Model" }} sizing={s} />, flow);
    fireEvent.doubleClick(container.querySelector('[data-width-grip="right"]') as HTMLElement);
    expect(s.onWidthChange).toHaveBeenCalledWith(undefined);
  });
});
