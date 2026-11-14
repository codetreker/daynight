import { createRef, useLayoutEffect, useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { isNativeSelectPopupOpen, NativeSelect } from "../src/ui/native-select/NativeSelect";

const options = <><option value="">Choose</option><optgroup label="Clients"><option value="codex">Codex</option><option value="claude" disabled>Claude Code</option></optgroup></>;

describe("NativeSelect", () => {
  it("preserves native form, label, description, ref and event targets", async () => {
    const ref = createRef<HTMLSelectElement>();
    const changes: { target: EventTarget; currentTarget: EventTarget; value: string }[] = [];
    const focus = vi.fn();
    render(<><form id="settings" /><label htmlFor="client">Client</label><p id="description">Client configuration</p>
      <NativeSelect ref={ref} id="client" name="client" form="settings" required aria-describedby="description"
        data-source="setup" defaultValue="" onFocus={focus}
        onChange={event => changes.push({ target: event.target, currentTarget: event.currentTarget, value: event.currentTarget.value })}>
        {options}
      </NativeSelect></>);
    const control = screen.getByRole("combobox", { name: "Client" });
    expect(control).toBe(ref.current);
    expect(control).toHaveAccessibleDescription("Client configuration");
    expect(control).toHaveAttribute("data-source", "setup");
    expect(ref.current!.checkValidity()).toBe(false);
    expect(ref.current!.form).toBe(document.getElementById("settings"));
    ref.current!.focus();
    expect(focus).toHaveBeenCalledOnce();
    expect(control).toHaveFocus();
    await userEvent.selectOptions(control, "codex");
    expect(changes).toEqual([{ target: control, currentTarget: control, value: "codex" }]);
    expect(new FormData(ref.current!.form!).get("client")).toBe("codex");
    expect(ref.current!.checkValidity()).toBe(true);
    await userEvent.selectOptions(control, "claude");
    expect(control).toHaveValue("codex");
    expect(changes).toHaveLength(1);
    const wrapper = control.parentElement!;
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper).not.toHaveAttribute("role");
    expect(wrapper).not.toHaveAttribute("tabindex");
    expect(wrapper.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(wrapper.querySelector("svg")).toHaveAttribute("focusable", "false");
  });
  it("retains the same select, its focus and draft value across unchanged rerenders", async () => {
    const change = vi.fn();
    const ref = vi.fn();
    const { rerender } = render(<NativeSelect ref={ref} aria-label="Client" defaultValue="codex" onChange={change}>{options}</NativeSelect>);
    const control = screen.getByRole("combobox");
    control.focus();
    await userEvent.selectOptions(control, "");
    change.mockClear();
    rerender(<NativeSelect ref={ref} aria-label="Client" defaultValue="codex" density="compact" pending onChange={change}>{options}</NativeSelect>);
    expect(screen.getByRole("combobox")).toBe(control);
    expect(control).toHaveValue("");
    expect(control).toHaveFocus();
    expect(change).not.toHaveBeenCalled();
    expect(ref).toHaveBeenCalledOnce();
    expect(ref).toHaveBeenCalledWith(control);
  });

  it("passes controlled values and caller supplied options without placeholder or change synthesis", () => {
    const change = vi.fn();
    const { rerender } = render(<NativeSelect aria-label="Page" value={2} onChange={change}><option value={1}>One</option><option value={2}>Two</option></NativeSelect>);
    const control = screen.getByRole("combobox");
    expect(control).toHaveValue("2");
    rerender(<NativeSelect aria-label="Page" value={1} onChange={change}><option value={1}>One</option><option value={2}>Two</option></NativeSelect>);
    expect(control).toHaveValue("1");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(change).not.toHaveBeenCalled();
  });

  it("preserves list size and array-valued native multiple selection", async () => {
    const ref = createRef<HTMLSelectElement>();
    const changes: string[][] = [];
    const { rerender } = render(<label>Projects<NativeSelect ref={ref} multiple size={5} defaultValue={[]}
      onChange={event => changes.push(Array.from(event.currentTarget.selectedOptions, option => option.value))}>
      <option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option>
    </NativeSelect></label>);
    const control = screen.getByRole("listbox", { name: "Projects" });
    expect(ref.current!.size).toBe(5);
    expect(ref.current!.selectedOptions).toHaveLength(0);
    expect(control.parentElement!.querySelector("svg")).toBeNull();
    await userEvent.selectOptions(control, ["a", "c"]);
    expect(changes.at(-1)).toEqual(["a", "c"]);
    rerender(<NativeSelect aria-label="List" size={3} defaultValue="b"><option value="a">Alpha</option><option value="b">Beta</option></NativeSelect>);
    const singleList = screen.getByRole("listbox", { name: "List" }) as HTMLSelectElement;
    expect(singleList.multiple).toBe(false);
    expect(singleList.size).toBe(3);
    expect(singleList).toHaveValue("b");
    expect(singleList.parentElement!.querySelector("svg")).toBeNull();
  });

  it("keeps native disabled semantics for direct and inherited fieldsets", async () => {
    const change = vi.fn();
    render(<><NativeSelect aria-label="Direct" disabled onChange={change}>{options}</NativeSelect>
      <fieldset disabled><NativeSelect aria-label="Inherited" onChange={change}>{options}</NativeSelect></fieldset></>);
    for (const control of screen.getAllByRole("combobox")) {
      expect(control).toBeDisabled();
      await userEvent.selectOptions(control, "codex");
      expect(control).toHaveValue("");
    }
    expect(change).not.toHaveBeenCalled();
  });

  it("maps presentation inputs without changing native availability or handling keys", () => {
    const onKeyDown = vi.fn();
    render(<NativeSelect aria-label="Client" density="filter" layout="fill" focusTone="task" touchMode="container"
      pending wrapperClassName="client-column" hidden dir="rtl" aria-invalid="true" onKeyDown={onKeyDown}>{options}</NativeSelect>);
    const control = screen.getByLabelText("Client");
    expect(control).toHaveAttribute("hidden");
    expect(control).toHaveAttribute("dir", "rtl");
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).not.toBeDisabled();
    expect(control.parentElement).toHaveClass("native-select", "client-column");
    expect(control.parentElement).toHaveAttribute("hidden");
    expect(control.parentElement).toHaveAttribute("dir", "rtl");
    expect(control.parentElement).toHaveAttribute("data-density", "filter");
    expect(control.parentElement).toHaveAttribute("data-layout", "fill");
    expect(control.parentElement).toHaveAttribute("data-focus-tone", "task");
    expect(control.parentElement).toHaveAttribute("data-touch-mode", "container");
    expect(control.parentElement).toHaveAttribute("data-pending", "true");
    expect(fireEvent.keyDown(control, { key: "Escape" })).toBe(true);
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it("identifies popup targets without synthesizing events or masking selector errors", () => {
    expect(isNativeSelectPopupOpen(null)).toBe(false);
    expect(isNativeSelectPopupOpen(document.createElement("input"))).toBe(false);
    const control = document.createElement("select");
    const matches = vi.spyOn(control, "matches").mockReturnValue(true);
    expect(isNativeSelectPopupOpen(control)).toBe(true);
    expect(matches).toHaveBeenCalledWith(":open");
    matches.mockReturnValue(false);
    expect(isNativeSelectPopupOpen(control)).toBe(false);
    const error = new Error("selector unavailable");
    matches.mockImplementation(() => { throw error; });
    expect(() => isNativeSelectPopupOpen(control)).toThrow(error);
  });

  it("allows the caller to keep exactly two options with selectedIndex -1", () => {
    const change = vi.fn();
    const Unadopted = ({ pending }: { pending: boolean }) => {
      const ref = useRef<HTMLSelectElement>(null);
      useLayoutEffect(() => { ref.current!.selectedIndex = -1; });
      return <NativeSelect ref={ref} aria-label="Mode" pending={pending} onChange={change}><option value="herdr">Herdr</option><option value="web">Web</option></NativeSelect>;
    };
    const { rerender } = render(<Unadopted pending={false} />);
    const control = screen.getByRole("combobox") as HTMLSelectElement;
    expect(control.selectedIndex).toBe(-1);
    expect(control.value).toBe("");
    rerender(<Unadopted pending />);
    expect(screen.getByRole("combobox")).toBe(control);
    expect(control.selectedIndex).toBe(-1);
    expect(control.options).toHaveLength(2);
    expect(change).not.toHaveBeenCalled();
  });
});
