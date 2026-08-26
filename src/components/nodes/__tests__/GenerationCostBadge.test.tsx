import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  formatGenerationCost,
  GenerationCostBadge,
} from "../GenerationCostBadge";
import type { GenerationCostReceipt } from "@/types";

const receipt: GenerationCostReceipt = {
  provider: "fal",
  requestId: "req-123",
  modelId: "fal-ai/flux/dev",
  units: 1,
  unit: "megapixels",
  unitPrice: 0.025,
  currency: "USD",
  cost: 0.025,
};

describe("GenerationCostBadge", () => {
  it("shows the final run price without rounding it to cents", () => {
    render(<GenerationCostBadge receipt={receipt} />);

    expect(screen.getByLabelText("Generation cost")).toHaveTextContent("$0.025");
  });

  it("shows an em dash when the final price is unavailable", () => {
    render(
      <GenerationCostBadge receipt={{ ...receipt, currency: null, cost: null }} />
    );

    expect(screen.getByLabelText("Generation cost")).toHaveTextContent("—");
  });

  it("has no hover tooltip", () => {
    render(<GenerationCostBadge receipt={receipt} />);

    expect(screen.getByLabelText("Generation cost")).not.toHaveAttribute("title");
  });

  it("formats whole-dollar costs with two decimals", () => {
    expect(formatGenerationCost(2, "USD")).toBe("$2.00");
  });
});
