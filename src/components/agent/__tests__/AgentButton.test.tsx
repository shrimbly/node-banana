import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentButton } from "@/components/agent/AgentButton";

describe("AgentButton", () => {
  it("toggles and reports its pressed state", () => {
    const onClick = vi.fn();
    const { rerender } = render(<AgentButton open={false} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Open agent" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<AgentButton open onClick={onClick} />);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("sits where it is told and uses the canvas chrome classes", () => {
    render(<AgentButton open={false} onClick={vi.fn()} style={{ right: 15, bottom: 173 }} />);
    const button = screen.getByRole("button", { name: "Open agent" });
    expect(button).toHaveStyle({ right: "15px", bottom: "173px" });
    expect(button.className).toContain("nodrag");
    expect(button.className).toContain("h-10 w-10");
  });

  it("is disabled and dimmed while the tutorial locks features", () => {
    render(<AgentButton open={false} disabled dimmed onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Open agent" });
    expect(button).toBeDisabled();
    expect(button.className).toContain("opacity-30");
  });

  it("shows a working dot while a turn runs", () => {
    const { container, rerender } = render(<AgentButton open={false} busy onClick={vi.fn()} />);
    expect(container.querySelector(".animate-ping")).not.toBeNull();
    rerender(<AgentButton open={false} onClick={vi.fn()} />);
    expect(container.querySelector(".animate-ping")).toBeNull();
  });
});
