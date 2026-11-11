import { useRef } from "react";
import { browserNavigation } from "../src/app/navigation";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { CurrentUser, ProjectAccess } from "../src/api/auth-types";
import type { ProjectTransferReceipt } from "../src/api/project-transfer";
import type { Team } from "../src/api/teams";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TransferResultNotice, useTransferNavigation } from "../src/features/management/transfer-navigation";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/teams", () => ({ getTeam: vi.fn() }));
vi.mock("../src/app/router", () => ({ navigate: vi.fn() }));
import { getTeam } from "../src/api/teams";
import { navigate } from "../src/app/router";

const userId = "00000000-0000-4000-8000-000000000001", sourceId = "00000000-0000-4000-8000-000000000002", targetId = "00000000-0000-4000-8000-000000000003", projectId = "00000000-0000-4000-8000-000000000004", personalId = "00000000-0000-4000-8000-000000000005";
const source = { id: sourceId, kind: "ordinary" as const, name: "Source" }, target = { id: targetId, kind: "ordinary" as const, name: "Target" };
const user: CurrentUser = { id: userId, name: null, email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const receipt: ProjectTransferReceipt = { projectId, sourceTeam: source, ownerTeam: target, ownership: { teamId: targetId, version: 2n }, changed: true, actorAccess: null };
const time = "2026-10-20T09:00:00Z";
const team: Team = { ...source, version: 1n, createdAt: time, updatedAt: time, membership: { teamId: sourceId, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } };
let scope: TaskCacheScope, controller: AbortController;
const refresh = vi.fn(), mismatch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); controller = new AbortController(); window.history.replaceState({}, "", `/projects/${projectId}/settings`);
  scope = { userId, signal: controller.signal, isInvalidated: false, principalMismatch: mismatch, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as unknown as TaskCacheScope;
});
const Harness = ({ value = receipt, ownsEditor = () => true }: { readonly value?: ProjectTransferReceipt; readonly ownsEditor?: () => boolean }) => {
  const transfer = useTransferNavigation(scope, user, refresh);
  const location = useRef(browserNavigation().snapshot());
  return <><button type="button" onClick={() => transfer.complete(value, { location: location.current, ownsEditor })}>Complete</button><TransferResultNotice result={transfer.result} retry={transfer.retry} dismiss={transfer.dismiss} /></>;
};
const render = createLocaleRender("en");

describe("confirmed transfer navigation", () => {
  it("retains access without a Team read or navigation", () => {
    const actorAccess: ProjectAccess = { projectId, ownerTeam: target, ownership: receipt.ownership, teamRole: "member", canTransfer: false, effectiveRole: "member", directGrant: null };
    render(<Harness value={{ ...receipt, actorAccess }} />); fireEvent.click(screen.getByText("Complete"));
    expect(screen.getByRole("status")).toHaveTextContent("Project transferred to Target");
    expect(getTeam).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("reads the exact source Team and navigates to it after loss of access", async () => {
    vi.mocked(getTeam).mockResolvedValue(team); render(<Harness />); fireEvent.click(screen.getByText("Complete"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/teams/${sourceId}`));
    expect(getTeam).toHaveBeenCalledWith(sourceId, userId, expect.any(AbortSignal), mismatch);
    expect(screen.getByRole("status")).toHaveTextContent("no longer have access");
  });
  it("uses Personal only for a definite source 404", async () => {
    vi.mocked(getTeam).mockRejectedValue(new ApiError("server", 404, "not_found")); render(<Harness />); fireEvent.click(screen.getByText("Complete"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/teams/${personalId}`));
  });
  it("preserves success and retries navigation on a network failure", async () => {
    vi.mocked(getTeam).mockRejectedValueOnce(new ApiError("network")).mockResolvedValueOnce(team); render(<Harness />); fireEvent.click(screen.getByText("Complete"));
    expect(await screen.findByRole("alert")).toHaveTextContent("transfer succeeded"); expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/teams/${sourceId}`));
    expect(getTeam).toHaveBeenCalledTimes(2);
  });
  it("does not redirect after the user leaves while retrying the source Team read", async () => {
    const pending = Promise.withResolvers<Team>();
    vi.mocked(getTeam).mockRejectedValueOnce(new ApiError("network")).mockReturnValueOnce(pending.promise);
    render(<Harness />); fireEvent.click(screen.getByText("Complete"));
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
    window.history.replaceState({}, "", "/workers");
    await act(async () => pending.resolve(team));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go to Team projects" })).toHaveAttribute("href", `/teams/${sourceId}`);
  });
  it("does not redirect when a transfer receipt arrives after leaving its settings page", async () => {
    vi.mocked(getTeam).mockResolvedValue(team); render(<Harness />);
    window.history.replaceState({}, "", "/workers"); fireEvent.click(screen.getByText("Complete"));
    await screen.findByRole("link", { name: "Go to Team projects" });
    expect(navigate).not.toHaveBeenCalled();
  });
  it("does not redirect after leaving and returning to the same settings entry before the receipt", async () => {
    vi.mocked(getTeam).mockResolvedValue(team);
    render(<Harness />);
    act(() => browserNavigation().navigate("/workers"));
    expect(window.location.pathname).toBe("/workers");
    act(() => window.history.back());
    await waitFor(() => expect(browserNavigation().snapshot().pathname).toBe(`/projects/${projectId}/settings`));
    fireEvent.click(screen.getByText("Complete"));
    await screen.findByRole("link", { name: "Go to Team projects" });
    expect(refresh).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("keeps the receipt but does not redirect when the editor changes during the source read", async () => {
    const pending = Promise.withResolvers<Team>();
    let original = true;
    vi.mocked(getTeam).mockReturnValueOnce(pending.promise);
    render(<Harness ownsEditor={() => original} />);
    fireEvent.click(screen.getByText("Complete"));
    await waitFor(() => expect(getTeam).toHaveBeenCalledOnce());
    original = false;
    await act(async () => pending.resolve(team));
    expect(screen.getByRole("status")).toHaveTextContent("Project transferred to Target");
    expect(screen.getByRole("link", { name: "Go to Team projects" })).toHaveAttribute("href", `/teams/${sourceId}`);
    expect(navigate).not.toHaveBeenCalled();
  });
  it("does not redirect a user who navigated away or install a response after identity invalidation", async () => {
    const pending = Promise.withResolvers<Team>(); vi.mocked(getTeam).mockReturnValueOnce(pending.promise);
    const view = render(<Harness />); fireEvent.click(screen.getByText("Complete")); await waitFor(() => expect(getTeam).toHaveBeenCalled());
    window.history.replaceState({}, "", "/workers"); await act(async () => pending.resolve(team)); expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go to Team projects" })).toHaveAttribute("href", `/teams/${sourceId}`);
    view.unmount();
    const next = Promise.withResolvers<Team>(); vi.mocked(getTeam).mockReturnValueOnce(next.promise); render(<Harness />); fireEvent.click(screen.getByText("Complete"));
    await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2)); controller.abort(); await act(async () => next.resolve(team)); expect(navigate).not.toHaveBeenCalled();
  });
});
