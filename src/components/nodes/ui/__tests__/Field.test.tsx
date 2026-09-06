import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NumberField, SelectField, TextField, CheckboxField, RangeField, ChipGroup } from "../Field";

describe("NumberField", () => {
  it("keeps local text while typing and commits a number on blur", () => {
    const onChange = vi.fn();
    render(<NumberField label="Steps" value={20} onChange={onChange} />);
    const input = screen.getByLabelText("Steps") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "3" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("3");
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("does not overwrite the text from the store while focused", () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberField label="Steps" value={20} onChange={onChange} />);
    const input = screen.getByLabelText("Steps") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "31" } });
    rerender(<NumberField label="Steps" value={99} onChange={onChange} />);
    expect(input.value).toBe("31");
    fireEvent.blur(input);
    rerender(<NumberField label="Steps" value={99} onChange={onChange} />);
    expect(input.value).toBe("99");
  });

  it("parses integers and clamps to min/max on commit", () => {
    const onChange = vi.fn();
    render(<NumberField label="Steps" value={undefined} onChange={onChange} min={1} max={50} integer />);
    const input = screen.getByLabelText("Steps") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "120" } });
    expect(input.title).toBe("Max: 50");
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(50);
    expect(input.value).toBe("50");
  });

  it("sends undefined when cleared", () => {
    const onChange = vi.fn();
    render(<NumberField label="Seed" value={7} onChange={onChange} />);
    const input = screen.getByLabelText("Seed");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("commits on Enter", () => {
    const onChange = vi.fn();
    render(<NumberField label="Seed" value={7} onChange={onChange} />);
    const input = screen.getByLabelText("Seed");
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(8);
  });
});

describe("SelectField", () => {
  it("renders options and an optional empty option", () => {
    const onChange = vi.fn();
    render(
      <SelectField
        label="Ratio"
        value="16:9"
        options={["1:1", "16:9", { value: "9:16", label: "Portrait" }]}
        onChange={onChange}
        emptyLabel="Default"
      />
    );
    const select = screen.getByLabelText("Ratio") as HTMLSelectElement;
    expect(select.value).toBe("16:9");
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("Portrait")).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "9:16" } });
    expect(onChange).toHaveBeenCalledWith("9:16");
  });

  it("forwards data-tutorial to the select element", () => {
    render(<SelectField label="Model" value="a" options={["a"]} onChange={() => {}} data-tutorial="generate-model-selector" />);
    expect(screen.getByLabelText("Model")).toHaveAttribute("data-tutorial", "generate-model-selector");
  });
});

describe("TextField", () => {
  it("commits trimmed-to-undefined empty text on blur", () => {
    const onChange = vi.fn();
    render(<TextField label="Name" value="x" onChange={onChange} />);
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});

describe("CheckboxField / RangeField / ChipGroup", () => {
  it("checkbox reports boolean", () => {
    const onChange = vi.fn();
    render(<CheckboxField label="Loop" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Loop"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("range shows a formatted readout", () => {
    render(<RangeField label="Temp" value={0.7} min={0} max={2} step={0.1} onChange={() => {}} format={(v) => v.toFixed(1)} />);
    expect(screen.getByText("0.7")).toBeInTheDocument();
  });

  it("chips are a radiogroup", () => {
    const onChange = vi.fn();
    render(
      <ChipGroup value="fast" options={[{ value: "fast", label: "Fast" }, { value: "quality", label: "Quality" }]} onChange={onChange} />
    );
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Quality" }));
    expect(onChange).toHaveBeenCalledWith("quality");
  });
});
