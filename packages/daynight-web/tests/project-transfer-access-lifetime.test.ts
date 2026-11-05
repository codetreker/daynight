import { expect, it, vi } from "vitest";
import { getProjectAccess } from "../src/api/auth";
import { ProjectAccessSession } from "../src/features/projects/ProjectAccess";
import { createTaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { directAccessFixture, TEST_VIEWER_ID } from "./helpers/taskSync";

vi.mock("../src/api/auth", () => ({ getProjectAccess: vi.fn() }));

it("pauses automatic access reads while a retained settings panel is hidden and revalidates on return", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const projectId = "00000000-0000-4000-8000-000000000101";
  const access = directAccessFixture(projectId);
  vi.mocked(getProjectAccess).mockResolvedValue(access);
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const session = new ProjectAccessSession(projectId, scope);
  const stop = session.start(false);
  try {
    session.publishSync(session.beginObservation(), access);
    session.setActive(false);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getProjectAccess).not.toHaveBeenCalled();
    session.setActive(true);
    await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(session.snapshot()).toMatchObject({ status: "ready", refreshing: false, access }));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  } finally { stop(); scope.dispose(); vi.useRealTimers(); }
});
