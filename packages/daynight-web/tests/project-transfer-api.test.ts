import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests } from "../src/api/client";
import { previewProjectTransfer, transferProject, type ProjectTransferPreview } from "../src/api/project-transfer";

const user = "00000000-0000-4000-8000-000000000001";
const project = "00000000-0000-4000-8000-000000000002";
const source = "00000000-0000-4000-8000-000000000003";
const target = "00000000-0000-4000-8000-000000000004";
const sourceRef = `{"id":"${source}","kind":"ordinary","name":"Source"}`;
const targetRef = `{"id":"${target}","kind":"ordinary","name":" Target "}`;
const previewBody = `{"sourceTeam":${sourceRef},"targetTeam":{"id":"${target}","kind":"ordinary","name":" Target ","version":9223372036854775807},"ownership":{"teamId":"${source}","version":9007199254740993},"actorRole":null}`;
const receiptBody = `{"projectId":"${project}","changed":true,"sourceTeam":${sourceRef},"ownerTeam":${targetRef},"ownership":{"teamId":"${target}","version":9007199254740994},"actorAccess":null}`;
const response = (body: string, principal = user, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const signal = () => new AbortController().signal;
const preview = (): ProjectTransferPreview => ({ sourceTeam: { id: source, kind: "ordinary", name: "Source" }, targetTeam: { id: target, kind: "ordinary", name: " Target ", version: 9223372036854775807n }, ownership: { teamId: source, version: 9007199254740993n }, actorRole: null });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe("project ownership transfer", () => {
  it("preserves int64 versions and accepts a committed receipt without actor access", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(previewBody)).mockResolvedValueOnce(response(receiptBody)); vi.stubGlobal("fetch", fetch);
    const candidate = await previewProjectTransfer(project, target, user, signal(), vi.fn());
    expect(candidate).toEqual(preview());
    const dispatched = vi.fn();
    const receipt = await transferProject(project, candidate, user, signal(), vi.fn(), dispatched);
    expect(receipt.actorAccess).toBeNull(); expect(receipt.ownership.version).toBe(9007199254740994n); expect(dispatched).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${project}/transfer-preview`);
    expect(fetch.mock.calls[1]?.[1].body).toBe(`{"ownership":{"teamId":"${source}","version":9007199254740993},"targetTeam":{"id":"${target}","version":9223372036854775807},"expectedUserId":"${user}"}`);
  });

  it("checks returned target, ownership, receipt, and authenticated principal", async () => {
    const mismatch = vi.fn();
    for (const body of [previewBody.replace(`"id":"${target}"`, `"id":"${source}"`), previewBody.replace(`"teamId":"${source}"`, `"teamId":"${target}"`), previewBody.replace("9223372036854775807", "9223372036854775808"), previewBody.replace('"actorRole":null', '"actorRole":"owner"')]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
      await expect(previewProjectTransfer(project, target, user, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
    }
    for (const body of [receiptBody.replace(`"projectId":"${project}"`, `"projectId":"${source}"`), receiptBody.replace('"changed":true', '"changed":false'), receiptBody.replace("9007199254740994", "9007199254740993"), receiptBody.replace('"actorAccess":null', '"actorAccess":{}')]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
      await expect(transferProject(project, preview(), user, signal(), mismatch, vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(receiptBody, target)));
    await expect(transferProject(project, preview(), user, signal(), mismatch, vi.fn())).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce();
  });

  it("accepts retained access and validates that it matches the receipt", async () => {
    const access = `{"projectId":"${project}","ownerTeam":${targetRef},"ownership":{"teamId":"${target}","version":9007199254740994},"effectiveRole":"member","teamRole":"member","directGrant":null,"canTransfer":false}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(receiptBody.replace('"actorAccess":null', `"actorAccess":${access}`))));
    const receipt = await transferProject(project, preview(), user, signal(), vi.fn(), vi.fn());
    expect(receipt.actorAccess?.ownership.version).toBe(9007199254740994n);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(receiptBody.replace('"actorAccess":null', `"actorAccess":${access.replace("9007199254740994", "9007199254740993")}`))));
    await expect(transferProject(project, preview(), user, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
  });

  it("accepts a verified same-owner no-op and allows the source name to change independently", async () => {
    const same = { ...preview(), targetTeam: { id: source, kind: "ordinary" as const, name: "Source", version: 3n } };
    const access = `{"projectId":"${project}","ownerTeam":${sourceRef},"ownership":{"teamId":"${source}","version":9007199254740993},"effectiveRole":"admin","teamRole":"admin","directGrant":null,"canTransfer":true}`;
    const noOp = `{"projectId":"${project}","changed":false,"sourceTeam":${sourceRef},"ownerTeam":${sourceRef},"ownership":{"teamId":"${source}","version":9007199254740993},"actorAccess":${access}}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(noOp)));
    expect((await transferProject(project, same, user, signal(), vi.fn(), vi.fn())).changed).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(receiptBody.replace(sourceRef, sourceRef.replace("Source", "Renamed")))));
    expect((await transferProject(project, preview(), user, signal(), vi.fn(), vi.fn())).sourceTeam.name).toBe("Renamed");
  });

  it("propagates identity mismatch and marks dispatch without replaying failures", async () => {
    const error = '{"error":{"code":"identity_mismatch","message":"wrong user","requestId":"req-1"}}';
    const mismatch = vi.fn(), dispatched = vi.fn(), fetch = vi.fn().mockResolvedValue(response(error, user, 409)); vi.stubGlobal("fetch", fetch);
    await expect(transferProject(project, preview(), user, signal(), mismatch, dispatched)).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce(); expect(dispatched).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("disconnected")));
    await expect(transferProject(project, preview(), user, signal(), vi.fn(), dispatched)).rejects.toMatchObject({ kind: "network" });
    expect(dispatched).toHaveBeenCalledTimes(2);
  });
});
