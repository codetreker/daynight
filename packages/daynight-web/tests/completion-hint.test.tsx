import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChainCompletionTime } from "../src/features/task-completion/ChainCompletionTime";
import { CompletionTimeLabel } from "../src/features/task-completion/CompletionTimeLabel";
import { useCompletionHint } from "../src/features/task-completion/useCompletionHint";
import type { CompletionValue } from "../src/features/task-completion/useCompletionTime";
import { LocaleProvider } from "../src/i18n/LocaleProvider";

const value: CompletionValue = { timestamp: "2026-01-02T03:04:05Z", label: "Completed just now", exact: "1/2/2026, 03:04:05" };
const locale = (children: React.ReactNode) => <LocaleProvider initial={{ locale: "en", issue: null }}>{children}</LocaleProvider>;
const Task = ({ completion, onOpen }: { completion: CompletionValue | null; onOpen: () => void }) => {
  const hint = useCompletionHint(completion);
  return <div><button ref={hint.triggerRef} aria-describedby={hint.descriptionId} {...hint.triggerEvents}
    onClick={() => { hint.triggerEvents.onClick(); onOpen(); }}>Task <CompletionTimeLabel value={completion} {...hint.labelEvents} /></button>{hint.hint}</div>;
};

const escape = () => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { document.dispatchEvent(event); });
  return event.defaultPrevented;
};

describe("completion hint interaction", () => {
  it("keeps a stable exact description, closes before task navigation, and yields Escape afterward", () => {
    const onOpen = vi.fn();
    const view = render(locale(<Task completion={value} onOpen={onOpen} />));
    const button = screen.getByRole("button", { name: "Task" });
    const description = button.getAttribute("aria-describedby");
    expect(description).toBeTruthy();
    expect(document.getElementById(description!)?.textContent).toBe("Completed: 1/2/2026, 03:04:05");
    fireEvent.focus(button);
    view.rerender(locale(<Task completion={{ ...value, label: "Completed 1 minute ago" }} onOpen={onOpen} />));
    expect(button.getAttribute("aria-describedby")).toBe(description);
    expect(escape()).toBe(true);
    expect(escape()).toBe(false);
    fireEvent.blur(button);
    fireEvent.focus(button);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(escape()).toBe(false);
    view.rerender(locale(<Task completion={null} onOpen={onOpen} />));
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("names the independent chain action and closes a pinned hint without activating other controls", () => {
    const external = vi.fn();
    const view = render(locale(<><ChainCompletionTime value={value} title="Build and ship" /><button onClick={external}>Other</button></>));
    const button = screen.getByRole("button", { name: "View completion time for Build and ship" });
    fireEvent.focus(button);
    fireEvent.click(button);
    view.rerender(locale(<><ChainCompletionTime value={{ ...value, label: "Completed 1 minute ago" }} title="Build and ship" /><button onClick={external}>Other</button></>));
    expect(escape()).toBe(true);
    fireEvent.blur(button);
    fireEvent.focus(button);
    fireEvent.click(button);
    const other = screen.getByRole("button", { name: "Other" });
    fireEvent.pointerDown(other);
    fireEvent.click(other);
    expect(external).toHaveBeenCalledOnce();
    expect(escape()).toBe(false);
  });
});
