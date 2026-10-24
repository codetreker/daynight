import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const otherProjectId = "33333333-3333-3333-3333-333333333333";
const taskId = "22222222-2222-2222-2222-222222222222";
const time = "2026-10-20T01:02:03.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@github.com:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = { id: taskId, projectId, title: "Task", description: "", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, version: 1n, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true };
const attachment = { path: "reports/result.bin", contentType: "application/octet-stream", sizeBytes: 5, createdAt: time, updatedAt: time };
const token = "opaque.+/_~=-token";
const cleanups: (() => void | Promise<void>)[] = [];
const operation = () => {
  const created = createOperation();
  cleanups.push(() => created.dispose());
  return created;
};
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(stringifyApiJson(value));
};
const server = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const created = createServer(handler);
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    created.close((error) => error === undefined ? resolve() : reject(error));
    created.closeAllConnections();
  }));
  const address = created.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("API bearer authentication", () => {
  it("omits Authorization when no server token is configured", async () => {
    const received: (string | undefined)[] = [];
    const url = await server((request, response) => {
      received.push(request.headers.authorization);
      json(response, project);
    });

    await expect(createApiClient({ serverUrl: url, operation: operation() }).getProject(projectId)).resolves.toEqual(project);
    expect(received).toEqual([undefined]);
  });

  it("sends the unchanged bearer token on JSON mutations and every list page", async () => {
    const received: { method: string | undefined; url: string | undefined; authorization: string | undefined; contentType: string | undefined }[] = [];
    const url = await server((request, response) => {
      received.push({ method: request.method, url: request.url, authorization: request.headers.authorization, contentType: request.headers["content-type"] });
      const path = new URL(request.url!, "http://127.0.0.1");
      if (request.method === "POST" && path.pathname === "/api/v1/projects") json(response, project, 201);
      else if (request.method === "POST") json(response, task, 201);
      else if (request.method === "PATCH") json(response, task);
      else if (path.searchParams.has("cursor")) json(response, { items: [{ ...project, id: otherProjectId }], nextCursor: null });
      else json(response, { items: [project], nextCursor: "opaque cursor+/=?" });
    });
    const api = createApiClient({ serverUrl: url, serverToken: token, operation: operation() });

    await api.createProject({ name: project.name, repoUrl: project.repoUrl });
    await api.createTask(projectId, { title: task.title });
    await api.updateTask(projectId, taskId, { version: 1n, title: "Updated" });
    await expect(api.listProjects()).resolves.toEqual([project, { ...project, id: otherProjectId }]);

    expect(received.map(({ method }) => method)).toEqual(["POST", "POST", "PATCH", "GET", "GET"]);
    expect(received.map(({ authorization }) => authorization)).toEqual(Array(5).fill(`Bearer ${token}`));
    expect(received.map(({ contentType }) => contentType)).toEqual(["application/json", "application/json", "application/json", undefined, undefined]);
    expect(new URL(received[4]!.url!, url).searchParams.get("cursor")).toBe("opaque cursor+/=?");
  });

  it("authenticates binary attachment upload, download, listing, and deletion", async () => {
    const bytes = Uint8Array.from([0, 255, 128, 10, 13]);
    const uploaded: Buffer[] = [];
    const received: { method: string | undefined; authorization: string | undefined; accept: string | undefined; contentType: string | undefined }[] = [];
    const url = await server((request, response) => {
      received.push({ method: request.method, authorization: request.headers.authorization, accept: request.headers.accept, contentType: request.headers["content-type"] });
      if (request.method === "PUT") {
        request.on("data", (chunk: Buffer) => uploaded.push(chunk));
        request.on("end", () => json(response, attachment, 201));
      } else if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
      } else if (request.url!.includes("/files/")) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(bytes);
      } else json(response, { items: [attachment], nextCursor: null });
    });
    const api = createApiClient({ serverUrl: url, serverToken: token, operation: operation() });
    const downloaded: Uint8Array[] = [];

    await expect(api.putTaskAttachment(projectId, taskId, attachment.path, {
      contentType: attachment.contentType,
      body: new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(bytes); controller.close(); } }),
    })).resolves.toEqual(attachment);
    await api.readTaskAttachment(projectId, taskId, attachment.path, async (chunk) => { downloaded.push(chunk); });
    await expect(api.listTaskAttachments(projectId, taskId)).resolves.toEqual([attachment]);
    await api.removeTaskAttachment(projectId, taskId, attachment.path);

    expect(Buffer.concat(uploaded)).toEqual(Buffer.from(bytes));
    expect(Buffer.concat(downloaded)).toEqual(Buffer.from(bytes));
    expect(received).toEqual([
      { method: "PUT", authorization: `Bearer ${token}`, accept: "application/json", contentType: attachment.contentType },
      { method: "GET", authorization: `Bearer ${token}`, accept: "*/*", contentType: undefined },
      { method: "GET", authorization: `Bearer ${token}`, accept: "application/json", contentType: undefined },
      { method: "DELETE", authorization: `Bearer ${token}`, accept: "application/json", contentType: undefined },
    ]);
  });

  it("authenticates the status request with exact int64 JSON", async () => {
    const received: { authorization: string | undefined; method: string | undefined; path: string | undefined; body: string }[] = [];
    const url = await server((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (value: string) => { body += value; });
      request.on("end", () => {
        received.push({ authorization: request.headers.authorization, method: request.method, path: request.url, body });
        json(response, { ...task, version: 9_223_372_036_854_775_807n });
      });
    });
    await createApiClient({ serverUrl: url, serverToken: token, operation: operation() }).setTaskStatus(projectId, taskId, { version: 9_223_372_036_854_775_807n, status: "todo" });
    expect(received).toEqual([{ authorization: `Bearer ${token}`, method: "PUT", path: `/api/v1/projects/${projectId}/tasks/${taskId}/status`, body: '{"version":9223372036854775807,"status":"todo"}' }]);
  });

  it("accepts the complete visible ASCII token without normalization", async () => {
    const opaque = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 0x21)).join("");
    const received: (string | undefined)[] = [];
    const url = await server((request, response) => {
      received.push(request.headers.authorization);
      json(response, project);
    });

    await createApiClient({ serverUrl: url, serverToken: opaque, operation: operation() }).getProject(projectId);
    expect(received).toEqual([`Bearer ${opaque}`]);
  });

  it.each(["", " ", "leading token", " token", "token ", "token\tvalue", "token\r\nInjected: value", "token\u0000", "token\u007f", "tokené"])("rejects a non-header-safe token %j before dispatch", (serverToken) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => createApiClient({ serverUrl: "https://example.com", serverToken, operation: operation(), fetch })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["http://service.localhost", "http://example.com", "http://192.168.1.2", "http://128.0.0.1", "http://[::2]", "http://[::ffff:127.0.0.1]"])("refuses a token over non-loopback HTTP at %s before dispatch", (serverUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => createApiClient({ serverUrl, serverToken: token, operation: operation(), fetch })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["http://localhost", "http://127.0.0.1", "http://127.254.3.2", "http://[::1]", "https://example.com"])("permits authenticated transport to %s", async (serverUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson(project), { headers: { "Content-Type": "application/json" } }));
    await expect(createApiClient({ serverUrl, serverToken: token, operation: operation(), fetch }).getProject(projectId)).resolves.toEqual(project);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
  });

  it.each(["valid JSON", "malformed JSON", "non-JSON"])("gives setup guidance for a 401 with %s and never retries", async (body) => {
    let requests = 0;
    const url = await server((_request, response) => {
      requests++;
      if (body === "valid JSON") json(response, { error: { code: "unauthorized", message: "Authentication required.", requestId: "req-401" } }, 401);
      else {
        response.writeHead(401, { "Content-Type": body === "malformed JSON" ? "application/json" : "text/plain" });
        response.end(body === "malformed JSON" ? "{" : "Authentication required.");
      }
    });
    const error: unknown = await createApiClient({ serverUrl: url, serverToken: token, operation: operation() }).createProject({ name: project.name, repoUrl: project.repoUrl }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, message: expect.stringContaining("daynight setup --server-token-stdin") });
    expect((error as Error).message).not.toContain(token);
    if (body === "valid JSON") expect(error).toMatchObject({ code: "unauthorized", requestId: "req-401", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(requests).toBe(1);
  });

  it.each([{ status: 403, code: "forbidden" }, { status: 404, code: "not_found" }, { status: 409, code: "version_conflict" }])("preserves the $status API refusal without authentication guidance or retry", async ({ status, code }) => {
    let requests = 0;
    const url = await server((_request, response) => {
      requests++;
      json(response, { error: { code, message: "Actual server explanation.", requestId: "req-refusal" } }, status);
    });
    const error: unknown = await createApiClient({ serverUrl: url, serverToken: token, operation: operation() }).setTaskStatus(projectId, taskId, { version: 1n, status: "done" }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code, requestId: "req-refusal", phase: "response", confirmedRefusal: true, outcomeUnconfirmed: false, message: expect.stringContaining("Actual server explanation.") });
    expect((error as Error).message).not.toContain("daynight setup --server-token-stdin");
    expect(requests).toBe(1);
  });

  it("does not forward authenticated mutations to a redirected origin", async () => {
    let redirectedRequests = 0;
    const destination = await server((_request, response) => {
      redirectedRequests++;
      json(response, project, 201);
    });
    const received: { method: string | undefined; authorization: string | undefined }[] = [];
    const origin = await server((request, response) => {
      received.push({ method: request.method, authorization: request.headers.authorization });
      response.writeHead(307, { Location: `${destination}/api/v1/projects`, "Content-Type": "application/json" });
      response.end("{}");
    });

    await expect(createApiClient({ serverUrl: origin, serverToken: token, operation: operation() }).createProject({ name: project.name, repoUrl: project.repoUrl })).rejects.toMatchObject({ status: 307, outcomeUnconfirmed: true });
    expect(received).toEqual([{ method: "POST", authorization: `Bearer ${token}` }]);
    expect(redirectedRequests).toBe(0);
  });
});
