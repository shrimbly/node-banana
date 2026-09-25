import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AgentMessage } from "@/components/agent/AgentMessage";
import type { AgentUIMessage } from "@/lib/agent/types";

const thinking: AgentUIMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    {
      type: "reasoning",
      text: "I should use create_workflow to add these nodes, as per rule 4.",
      state: "streaming",
    },
  ],
};

describe("AgentMessage reasoning", () => {
  it("stays collapsed while it streams: a Thinking… line, not the model's working notes (UX audit)", () => {
    render(<AgentMessage message={thinking} streaming />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText(/create_workflow/)).not.toBeInTheDocument();
  });

  it("opens on request", () => {
    render(<AgentMessage message={thinking} streaming />);
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    expect(screen.getByText(/create_workflow/)).toBeInTheDocument();
  });

  it("stays open when opened after the reply finished", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<AgentMessage message={thinking} streaming />);
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      const done: AgentUIMessage = { ...thinking, parts: [{ ...thinking.parts[0], state: "done" } as AgentUIMessage["parts"][number]] };
      rerender(<AgentMessage message={done} streaming={false} />);
      fireEvent.click(screen.getByRole("button", { name: /Thought for/ }));
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText(/create_workflow/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
