import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountChangeBanner } from "../src/features/auth/AccountChangeBanner";
import { renderWithLocale } from "./helpers/renderWithLocale";

describe("AccountChangeBanner", () => {
  it("only announces the active header and invokes the supplied reload action", () => {
    const reload = vi.fn();
    const { rerender } = renderWithLocale(<AccountChangeBanner active={false} onReload={reload} />, { locale: "en" });
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    rerender(<AccountChangeBanner active onReload={reload} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Account changed");
    fireEvent.click(screen.getByRole("button", { name: "Refresh page" }));
    expect(reload).toHaveBeenCalledOnce();
    rerender(<AccountChangeBanner active={false} onReload={reload} />);
    expect(status).toBeEmptyDOMElement();
  });
});
