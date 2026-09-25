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

  it("sits where it is told, as a 40px chrome card holding one chrome icon button", () => {
    render(<AgentButton open={false} onClick={vi.fn()} style={{ right: 15, bottom: 173 }} />);
    const card = screen.getByTestId("agent-button");
    expect(card).toHaveStyle({ right: "15px", bottom: "173px" });
    expect(card.className).toContain("nodrag");
    expect(card.className).toContain("h-10 w-10");
    expect(card.className).toContain("backdrop-blur-md");
    expect(card).toContainElement(screen.getByRole("button", { name: "Open agent" }));
  });

  it("lights up like an open chrome button while the window is open", () => {
    const { rerender } = render(<AgentButton open={false} onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Open agent" });
    expect(button.className).not.toContain("bg-white/10");
    rerender(<AgentButton open onClick={vi.fn()} />);
    expect(button.className).toContain("bg-white/10");
  });

  it("is disabled and dimmed while the tutorial locks features", () => {
    render(<AgentButton open={false} disabled dimmed onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open agent" })).toBeDisabled();
    expect(screen.getByTestId("agent-button").className).toContain("opacity-30");
  });

  it("shows a working dot while a turn runs", () => {
    const { container, rerender } = render(<AgentButton open={false} busy onClick={vi.fn()} />);
    expect(container.querySelector(".animate-ping")).not.toBeNull();
    rerender(<AgentButton open={false} onClick={vi.fn()} />);
    expect(container.querySelector(".animate-ping")).toBeNull();
  });
});
