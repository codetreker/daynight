import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "../src/features/landing/LandingPage";
import { blockedBy, demoTasks, taskIds, taskState } from "../src/features/landing/demo";
import { en } from "../src/i18n/messages/en";
import { renderWithLocale } from "./helpers/renderWithLocale";

const user = { id: "00000000-0000-4000-8000-000000000001", name: "Reader", email: "reader@example.com", emailVerified: true, avatarUrl: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const failure = (status: number) => json({ error: { code: status === 401 ? "unauthenticated" : "internal_error", message: "Private diagnostics", requestId: "landing-check" } }, status);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const install = (response: Response | Promise<Response> = failure(401)) => {
  const fetcher = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
const m = en.landing;
const scene = (id: "context" | "dependencies" | "evidence") => screen.getByRole("tab", { name: new RegExp(m.demo.scenes[id].label) });

beforeEach(() => {
  for (const element of document.head.querySelectorAll('meta[name="description"], meta[property^="og:"]')) element.remove();
});

describe("public landing page", () => {
  it("renders all public content before identity resolves and makes only a navigation identity read", async () => {
    const pending = deferred<Response>();
    const fetcher = install(pending.promise);
    const { unmount } = renderWithLocale(<LandingPage />, { locale: "en" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(m.hero.title.join(""));
    expect(screen.getByRole("link", { name: m.hero.demo })).toHaveAttribute("href", "#demo");
    expect(screen.getByRole("link", { name: m.hero.start })).toHaveAttribute("href", "/setup");
    expect(screen.getByRole("link", { name: new RegExp(m.navigation.unknown) })).toHaveAttribute("href", "/login");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/me", expect.objectContaining({ signal: expect.any(AbortSignal) })]);
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(json(user)));
  });

  it("offers sign-in for an anonymous visitor and the workspace for an authenticated visitor", async () => {
    const fetcher = install();
    const { unmount } = renderWithLocale(<LandingPage />, { locale: "en" });
    expect(await screen.findByRole("link", { name: m.navigation.login })).toHaveAttribute("href", "/login");
    unmount();
    fetcher.mockResolvedValue(json(user));
    renderWithLocale(<LandingPage />, { locale: "en" });
    expect(await screen.findByRole("link", { name: m.navigation.workspace })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(m.hero.title.join(""));
  });

  it.each(["server", "network", "protocol"] as const)("keeps unknown identity explicit and public actions usable after a %s error", async (kind) => {
    const fetcher = install(kind === "server" ? failure(503) : json({ malformed: true }));
    if (kind === "network") fetcher.mockRejectedValue(new TypeError("Controlled connection failure"));
    renderWithLocale(<LandingPage />, { locale: "en" });
    expect(await screen.findByRole("status")).toHaveTextContent(m.navigation.identityFailed);
    expect(screen.getByRole("link", { name: /Sign in \/ workspace/ })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: /^Open workspace →$/ })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
    expect(screen.queryByText("Private diagnostics")).toBeNull();
    expect(screen.getByRole("link", { name: m.hero.start })).toHaveAttribute("href", "/setup");
  });

  it("ignores an aborted navigation hint without replacing the public page", async () => {
    const fetcher = install();
    fetcher.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    renderWithLocale(<LandingPage />, { locale: "en" });
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("link", { name: /Sign in \/ workspace/ })).toHaveAttribute("href", "/login");
  });

  it("updates existing metadata in place without duplicates", async () => {
    const metadata = document.createElement("meta");
    metadata.name = "description";
    metadata.content = "Previous page";
    document.head.append(metadata);
    install();
    const { setLocale } = renderWithLocale(<LandingPage />, { locale: "en" });
    expect(document.querySelector('meta[name="description"]')).toBe(metadata);
    expect(metadata.content).toBe(m.metadata.description);
    setLocale("zh-CN");
    expect(document.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
    await act(async () => {});
  });
});

describe("local interactive product example", () => {
  it("derives ready and waiting states from the actual sample dependencies", () => {
    expect(taskIds).toHaveLength(6);
    expect(taskIds.map(taskState)).toEqual(["done", "done", "running", "ready", "blocked", "blocked"]);
    expect(blockedBy("email")).toEqual(["api"]);
    expect(blockedBy("verification")).toEqual(["api", "ui", "email"]);
    expect(blockedBy("ui")).toEqual([]);
    for (const id of taskIds) for (const prerequisite of demoTasks[id].dependsOn) expect(taskIds).toContain(prerequisite);
  });

  it("lets visitors inspect every task and follow prerequisites to the blocking work without business requests", async () => {
    const fetcher = install();
    const interaction = userEvent.setup();
    const { container } = renderWithLocale(<LandingPage />, { locale: "en" });
    const panel = screen.getByRole("tabpanel");
    const detail = container.querySelector(".task-detail")!;
    expect(within(detail as HTMLElement).getByRole("heading", { level: 4 })).toHaveTextContent(m.demo.tasks.email.title);
    expect(detail).toHaveTextContent(m.demo.blockedNote({ tasks: m.demo.tasks.api.title }));
    await interaction.click(within(detail as HTMLElement).getByRole("button", { name: /Invitation API/ }));
    expect(within(detail as HTMLElement).getByRole("heading", { level: 4 })).toHaveTextContent(m.demo.tasks.api.title);
    expect(panel.querySelector('[data-demo-task="api"]')).toHaveFocus();
    for (const id of taskIds) {
      const button = panel.querySelector<HTMLButtonElement>(`[data-demo-task="${id}"]`)!;
      await interaction.click(button);
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(detail).toHaveTextContent(m.demo.tasks[id].description);
      m.demo.tasks[id].acceptance.forEach((item) => expect(detail).toHaveTextContent(item));
    }
    expect(detail).toHaveTextContent(m.demo.blockedNote({ tasks: new Intl.ListFormat("en").format([m.demo.tasks.api.title, m.demo.tasks.ui.title, m.demo.tasks.email.title]) }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("opens all context documents and completed-example evidence without changing the current task state", async () => {
    install();
    const interaction = userEvent.setup();
    renderWithLocale(<LandingPage />, { locale: "en" });
    await interaction.click(scene("context"));
    for (const document of Object.values(m.demo.documents)) {
      await interaction.click(screen.getByRole("button", { name: document.label }));
      expect(screen.getByRole("heading", { name: document.title })).toBeVisible();
      expect(screen.getByText(document.callout.title)).toBeVisible();
    }
    await interaction.click(scene("evidence"));
    expect(screen.getByText(m.demo.completed.eyebrow)).toBeVisible();
    for (const id of ["acceptance", "changes", "handoff"] as const) {
      await interaction.click(screen.getByRole("button", { name: m.demo.receiptLabels[id] }));
      expect(screen.getByRole("heading", { name: m.demo.receipts[id].title })).toBeVisible();
    }
    await interaction.click(scene("dependencies"));
    expect(screen.getByRole("button", { name: /Invitation email Waiting/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("supports scene keyboard navigation with wrapping, Home, End and visible selected state", async () => {
    install();
    const interaction = userEvent.setup();
    renderWithLocale(<LandingPage />, { locale: "en" });
    scene("dependencies").focus();
    await interaction.keyboard("{ArrowRight}");
    expect(scene("evidence")).toHaveFocus();
    expect(scene("evidence")).toHaveAttribute("aria-selected", "true");
    await interaction.keyboard("{ArrowRight}");
    expect(scene("context")).toHaveFocus();
    await interaction.keyboard("{ArrowLeft}");
    expect(scene("evidence")).toHaveFocus();
    await interaction.keyboard("{Home}");
    expect(scene("context")).toHaveFocus();
    await interaction.keyboard("{End}");
    expect(scene("evidence")).toHaveFocus();
    await interaction.keyboard("x");
    expect(scene("evidence")).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("focuses the demo from both primary actions and preserves native FAQ behavior", async () => {
    install();
    const interaction = userEvent.setup();
    const { container } = renderWithLocale(<LandingPage />, { locale: "en" });
    await interaction.click(screen.getByRole("link", { name: m.hero.demo }));
    expect(container.querySelector("#demo")).toHaveFocus();
    await interaction.click(screen.getByRole("link", { name: m.closing.demo }));
    expect(container.querySelector("#demo")).toHaveFocus();
    const faq = screen.getByText(m.faq.items[1]!.title).closest("details")!;
    expect(faq.open).toBe(false);
    fireEvent.click(within(faq).getByText(m.faq.items[1]!.title));
    await waitFor(() => expect(faq.open).toBe(true));
  });
});
