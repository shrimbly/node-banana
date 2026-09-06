import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ControlsCard, SummaryValues } from "../ControlsCard";

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
});
