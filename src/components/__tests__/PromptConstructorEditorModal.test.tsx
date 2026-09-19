import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { PromptConstructorEditorModal } from "@/components/modals/PromptConstructorEditorModal";

const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, "localStorage", { value: mockLocalStorage, writable: true });

const writeText = vi.fn();
Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

const variables = [
  { name: "subject", value: "a red car", nodeId: "p1" },
  { name: "style", value: "studio lighting", nodeId: "p2" },
];

const renderModal = (props: Partial<React.ComponentProps<typeof PromptConstructorEditorModal>> = {}) =>
  render(
    <PromptConstructorEditorModal
      isOpen
      initialTemplate="Photo of @subject, @style"
      availableVariables={variables}
      onSubmit={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />
  );

describe("PromptConstructorEditorModal resolved preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.getItem.mockReturnValue(null);
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the template with its variables substituted", () => {
    renderModal();
    expect(screen.getByText("Photo of a red car, studio lighting")).toBeInTheDocument();
  });

  it("copies the resolved text, not the template, and confirms briefly", async () => {
    vi.useFakeTimers();
    renderModal();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy resolved prompt" }));
    });

    expect(writeText).toHaveBeenCalledWith("Photo of a red car, studio lighting");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole("button", { name: "Copy resolved prompt" })).toBeInTheDocument();
  });

  it("offers the preview and copy even before any variable is connected", () => {
    renderModal({ initialTemplate: "Plain prompt", availableVariables: [] });

    expect(screen.getByText("Plain prompt", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy resolved prompt" })).toBeEnabled();
  });

  it("hides the preview for an empty template with nothing connected", () => {
    renderModal({ initialTemplate: "", availableVariables: [] });

    expect(screen.queryByText("Resolved Preview")).not.toBeInTheDocument();
  });

  it("disables copy when the resolved text is empty", () => {
    renderModal({ initialTemplate: "", availableVariables: variables });

    expect(screen.getByText("Empty template")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy resolved prompt" })).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
  });
});
