import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
});
