import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { FTUXModal } from "../onboarding/FTUXModal";

vi.mock("../onboarding/FTUXWelcomeStep", () => ({ FTUXWelcomeStep: () => <div>welcome step</div> }));
vi.mock("../onboarding/FTUXApiKeysStep", () => ({ FTUXApiKeysStep: () => <div>keys step</div> }));
vi.mock("../onboarding/FTUXModelDefaultsStep", () => ({ FTUXModelDefaultsStep: () => <div>defaults step</div> }));
vi.mock("../onboarding/FTUXReadyStep", () => ({ FTUXReadyStep: () => <div>ready step</div> }));

describe("FTUXModal", () => {
  it("renders the welcome step in a labelled dialog that Escape does not dismiss", () => {
    const onComplete = vi.fn();
    render(<FTUXModal onComplete={onComplete} onStartTutorial={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Welcome to Node Banana" })).toBeInTheDocument();
    expect(screen.getByText("welcome step")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("steps forward with Next and asks before skipping from the close button", () => {
    const onComplete = vi.fn();
    render(<FTUXModal onComplete={onComplete} onStartTutorial={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("keys step")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.getByText("Skip setup?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
