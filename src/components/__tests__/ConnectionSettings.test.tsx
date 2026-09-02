import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionSettings, ConnectionPreview } from "@/components/settings/ConnectionSettings";
import { defaultEdgeAppearance } from "@/types";

const renderSettings = (overrides = {}) => {
  const props = {
    edgeStyle: "curved" as const,
    appearance: { ...defaultEdgeAppearance },
    onEdgeStyleChange: vi.fn(),
    onAppearanceChange: vi.fn(),
    onSetDefault: vi.fn(),
    defaultSaved: false,
    ...overrides,
  };
  render(<ConnectionSettings {...props} />);
  return props;
};

describe("ConnectionSettings", () => {
  it("marks the current line style and thickness", () => {
    renderSettings({ edgeStyle: "angular", appearance: { ...defaultEdgeAppearance, thickness: "thick" } });
    expect(screen.getByRole("radio", { name: "Angular" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Curved" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Thick" })).toHaveAttribute("aria-checked", "true");
  });

  it("reports a line style change", () => {
    const props = renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "Straight" }));
    expect(props.onEdgeStyleChange).toHaveBeenCalledWith("straight");
  });

  it("reports a thickness change with the rest of the appearance intact", () => {
    const props = renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "Thin" }));
    expect(props.onAppearanceChange).toHaveBeenCalledWith({ ...defaultEdgeAppearance, thickness: "thin" });
  });

  it("reports a label mode change", () => {
    const props = renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "Never" }));
    expect(props.onAppearanceChange).toHaveBeenCalledWith({ ...defaultEdgeAppearance, labels: "never" });
  });

  it("reports the faded opacity as a fraction", () => {
    const props = renderSettings();
    fireEvent.change(screen.getByLabelText("Faded connections opacity"), { target: { value: "60" } });
    expect(props.onAppearanceChange).toHaveBeenCalledWith({ ...defaultEdgeAppearance, fadedOpacity: 0.6 });
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("toggles the gradient and loading pulse switches", () => {
    const props = renderSettings();
    fireEvent.click(screen.getByRole("switch", { name: "Gradient" }));
    expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ ...defaultEdgeAppearance, gradient: false });
    fireEvent.click(screen.getByRole("switch", { name: "Loading pulse" }));
    expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ ...defaultEdgeAppearance, loadingPulse: false });
  });

  it("offers to save the draft as the user default", () => {
    const props = renderSettings();
    expect(screen.getByText("Saved with this workflow.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set as my default" }));
    expect(props.onSetDefault).toHaveBeenCalled();
  });

  it("confirms once the default is saved", () => {
    renderSettings({ defaultSaved: true });
    expect(screen.getByText("Saved as your default for new workflows.")).toBeInTheDocument();
  });
});

describe("ConnectionPreview", () => {
  it("draws both noodles with the chosen thickness and gradient", () => {
    render(<ConnectionPreview edgeStyle="curved" appearance={{ ...defaultEdgeAppearance, thickness: "thick" }} />);
    const image = screen.getByTestId("connection-preview-image");
    expect(image).toHaveAttribute("stroke-width", "5");
    expect(image.getAttribute("stroke")).toContain("url(#connection-preview-image)");
    expect(image.getAttribute("d")).toContain("C");
  });

  it("draws solid faded strokes when the gradient is off", () => {
    render(<ConnectionPreview edgeStyle="straight" appearance={{ ...defaultEdgeAppearance, gradient: false, fadedOpacity: 0.4 }} />);
    const text = screen.getByTestId("connection-preview-text");
    expect(text.getAttribute("stroke")).not.toContain("url(#");
    expect(text).toHaveAttribute("stroke-opacity", "0.4");
    expect(text.getAttribute("d")).not.toMatch(/[CQ]/);
  });
});
