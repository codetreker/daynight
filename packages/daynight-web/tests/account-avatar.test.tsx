import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../src/app/AccountMenu";
import { createLocaleRender } from "./helpers/renderWithLocale";

const render = createLocaleRender("en");
const props = { name: "Alice", userId: "alice", avatarUrl: "https://example.test/a.png", onSignOut: vi.fn() };

describe("account avatar", () => {
  it("keeps the initial while loading and falls back without retrying a failed source", () => {
    const view = render(<AccountMenu {...props} />);
    const trigger = screen.getByRole("button", { name: "Account menu: Alice" });
    const avatar = trigger.querySelector(".avatar")!;
    const image = avatar.querySelector("img")!;
    expect(avatar).toHaveTextContent("A");
    expect(image).not.toHaveClass("loaded");
    fireEvent.error(image);
    expect(avatar.querySelector("img")).toBeNull();
    view.rerender(<AccountMenu {...props} />);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar).toHaveTextContent("A");
  });

  it("isolates old errors from a new source or account and preserves the open menu on revalidation", () => {
    const view = render(<AccountMenu {...props} />);
    const trigger = screen.getByRole("button", { name: "Account menu: Alice" });
    const oldImage = trigger.querySelector("img")!;
    fireEvent.click(trigger);
    fireEvent.load(oldImage);
    expect(trigger.querySelector(".account-avatar-initial-hidden")).toHaveTextContent("A");
    view.rerender(<AccountMenu {...props} />);
    expect(trigger.querySelector("img")).toBe(oldImage);
    expect(oldImage).toHaveClass("loaded");
    expect(screen.getByRole("menu")).toBeVisible();
    view.rerender(<AccountMenu {...props} avatarUrl="https://example.test/b.png" />);
    const nextImage = trigger.querySelector("img")!;
    fireEvent.error(oldImage);
    fireEvent.load(nextImage);
    expect(trigger.querySelector("img")).toBe(nextImage);
    expect(nextImage).toHaveClass("loaded");
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.error(nextImage);
    view.rerender(<AccountMenu {...props} userId="bob" name="Bob" avatarUrl="https://example.test/b.png" />);
    expect(screen.getByRole("button", { name: "Account menu: Bob" }).querySelector("img")).toHaveAttribute("src", "https://example.test/b.png");
  });

  it.each([null, ""])("renders the initial without an image for %s", (avatarUrl) => {
    render(<AccountMenu {...props} avatarUrl={avatarUrl} />);
    const avatar = screen.getByRole("button", { name: "Account menu: Alice" }).querySelector(".avatar")!;
    expect(avatar).toHaveTextContent("A");
    expect(avatar.querySelector("img")).toBeNull();
  });
});
