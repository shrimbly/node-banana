import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaintedNodes } from "../../paintMode";
import { PendingTaskNotice, sentAt } from "../PendingTaskNotice";

const task = {
  provider: "kie",
  taskId: "task-1",
  modelId: "m",
  modelName: "M",
  mediaType: "image",
  submittedAt: Date.now() - 5 * 60_000,
};

describe("PendingTaskNotice", () => {
  it("says how long ago the request was sent on a live card", () => {
    render(<PendingTaskNotice task={task} onPickUp={() => {}} />);
    expect(screen.getByText("Sent 5 min ago")).toBeTruthy();
  });

  it("says when it was sent on a painted card, which would otherwise go stale", () => {
    render(
      <PaintedNodes>
        <PendingTaskNotice task={task} onPickUp={() => {}} />
      </PaintedNodes>
    );
    expect(screen.getByText(`Sent ${sentAt(task.submittedAt)}`)).toBeTruthy();
    expect(screen.queryByText(/ago/)).toBeNull();
  });
});
