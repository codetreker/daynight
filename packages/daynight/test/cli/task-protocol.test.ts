import { describe, expect, it } from "vitest";
import { parseApiJson } from "../../src/api/json.js";
import type { Task, TaskGraph } from "../../src/api/types.js";
import { actorId as observationActorId, withTaskObservation, withGraphObservations, workPage } from "../fixtures/task-observation.js";
import { projectId, taskId, secondId, thirdId, accountId, time, project, task, taskListItem, graph, taskPath, projectPath, respond, refuse, fixture, explicit } from "../fixtures/compiled-task.js";

// These protocol assertions use the real compiled CLI and loopback HTTP. Native
// environment, Git, file-transfer and process-lifetime sentinels stay in task.test.ts.
describe("compiled Task Session observation commands", () => {
  it("prints one grouped JSON page and forwards its cursor through the compiled CLI", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((_request, response) => {
        response.setHeader("Daynight-User-ID", observationActorId);
        respond(response, workPage);
      });
      const result = await f.invoke(["list", "--status", "in_progress", "--group-by", "chain", "--cursor", "group+/=", "--json", ...explicit]);
      expect(result.code, result.stderr).toBe(0);
      expect(parseApiJson(result.stdout)).toEqual(workPage);
      expect(result.stderr).toBe("");
      expect(requests.filter(request => request.pathname.endsWith("/task-work")).map(request => Object.fromEntries(request.query))).toEqual([{ assignedTo: "me", cursor: "group+/=" }]);
    } finally { await f.close(); }
  });
});

describe("compiled Task Thread commands", () => {
  const accountId = "aabbccdd-1111-4111-8111-111111111111";
  const messageId = "dddddddd-1111-4111-8111-111111111111";
  const threadPath = `${taskPath}/${taskId}/thread/messages`;
  const threadMessage = { id: messageId, author: { userId: accountId, displayName: null, Agent: false }, createdAt: "2026-11-03T10:20:30.000Z", body: "  中文\n\tId: forged\nHas more messages after...\n" };

  it("keeps unknown and definite POST failures distinct without leaking server text or replaying", async () => {
    const f = await fixture();
    try {
      let mode: "clock" | "unknown" | "invalid" = "clock";
      const { requests } = await f.serve((_request, response) => {
        if (mode === "invalid") {
          response.writeHead(201, { "Content-Type": "application/json", "Daynight-User-ID": accountId });
          response.end(JSON.stringify(threadMessage).replace('"body":', '"body":"secret Markdown","body":'));
        } else respond(response, { error: { code: mode === "clock" ? "clock_not_advanced" : "message_outcome_unknown", requestId: "thread-failure", message: "secret Markdown and credentials" } }, 503);
      });
      const args = ["thread", "post", taskId, `--body=${threadMessage.body}`, ...explicit];
      const definite = await f.invoke(args);
      expect(definite.code).toBe(1); expect(definite.stdout).toBe("");
      expect(definite.stderr).toContain("code=clock_not_advanced"); expect(definite.stderr).not.toContain("outcome is unknown");
      for (const next of ["unknown", "invalid"] as const) {
        mode = next;
        const unknown = await f.invoke(args);
        expect(unknown.code).toBe(1); expect(unknown.stdout).toBe("");
        expect(unknown.stderr).toContain("The posting outcome is unknown.");
        expect(unknown.stderr).not.toContain("secret"); expect(unknown.stderr).not.toContain("Id: forged");
      }
      expect(requests).toHaveLength(3);
    } finally { await f.close(); }
  });
});

describe("compiled task commands", () => {
  it("updates explicit permission values and filters list/ready before printing with the compiled CLI", async () => {
    const f = await fixture();
    let current = task({ version: 9_007_199_254_740_993n });
    try {
      const { requests } = await f.serve((request, response) => {
        if (request.method === "PATCH") {
          const input = request.body as { version: bigint; allowAgents: boolean };
          current = { ...current, allowAgents: input.allowAgents, version: input.version + 1n };
          respond(response, current);
        } else if (request.pathname === `${taskPath}/${taskId}`) respond(response, current);
        else respond(response, { items: [current], nextCursor: request.query.get("limit") === "1" ? "not-followed" : null });
      });
      for (const allowAgents of [true, false]) {
        const version = current.version;
        const before = requests.length;
        const result = await f.invoke(["update", taskId, "--allow-agents", String(allowAgents), "--if-version", version.toString(), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(`Task updated.\nProject: ${projectId}\nID: ${taskId}\nVersion: ${version + 1n}\n`);
        expect(requests.slice(before).map(({ method }) => method)).toEqual(["PATCH"]);
        expect(requests.at(-1)!.body).toEqual({ version, allowAgents });
        const listed = await f.invoke(["list", "--allow-agents", String(allowAgents), "--ready", "--json", ...explicit]);
        expect(listed.code, listed.stderr).toBe(0);
        expect(parseApiJson(listed.stdout)).toEqual([taskListItem(current)]);
        expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", allowAgents: String(allowAgents), limit: "100", include: "session" });
        const readyBefore = requests.length;
        const ready = await f.invoke(["ready", "--allow-agents", String(allowAgents), "--limit", "1", "--json", ...explicit]);
        expect(ready.code, ready.stderr).toBe(0);
        expect(parseApiJson(ready.stdout)).toEqual([current]);
        expect(requests.slice(readyBefore).length).toBe(2);
        expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", limit: "1", allowAgents: String(allowAgents) });
      }
    } finally { await f.close(); }
  }, 60_000);

  it("retains external dependency classifications in every compiled read shape and reports their count separately", async () => {
    const f = await fixture();
    try {
      const current = task({ allowAgents: true, description: "Complete Markdown\n\n```text\nexternal dependency\n```", version: 9_223_372_036_854_775_807n, dependsOn: [secondId, thirdId], externalDependsOn: [thirdId] });
      const graphValue: TaskGraph = {
        ...graph(),
        summary: { total: 3, proposed: 0, todo: 1, inProgress: 0, done: 2, cancelled: 0, ready: 1, blocked: 0 },
        tasks: [
          { ...graph().tasks[0]!, allowAgents: current.allowAgents, dependsOn: current.dependsOn, externalDependsOn: current.externalDependsOn },
          { ...graph().tasks[0]!, id: secondId, status: "done", ready: false },
          { ...graph().tasks[0]!, id: thirdId, status: "done", ready: false },
        ],
      };
      await f.serve((request, response) => {
        if (request.pathname.endsWith("/task-graph")) respond(response, graphValue);
        else if (request.pathname === taskPath) respond(response, { items: [current], nextCursor: null });
        else respond(response, current);
      });
      const commands = ["show", "list", "ready", "graph"];
      const output = await f.invokeBatch(commands.flatMap(command => {
        const args = (command === "show" || command === "graph") ? [command, taskId] : [command];
        return [[...args, ...explicit], [...args, "--json", ...explicit]];
      }));
      for (const [index, command] of commands.entries()) {
        const human = output[index * 2]!;
        expect(human.code, human.stderr).toBe(0);
        expect(human.stdout).toContain("Automatic execution: true");
        expect(human.stdout).toContain(`Depends on: ${secondId}, ${thirdId}`);
        expect(human.stdout).toContain(`External dependencies (1): ${thirdId}`);
        const json = output[index * 2 + 1]!;
        expect(json.code, json.stderr).toBe(0);
        const resource = parseApiJson(json.stdout);
        expect(resource).toEqual(command === "list" ? [taskListItem(current)] : command === "ready" ? [current] : command === "graph" ? withGraphObservations(graphValue, taskId) : withTaskObservation(current));
        if (command === "list") expect(resource).not.toHaveProperty("0.description");
        if (command !== "graph") expect(json.stdout).toContain('"version":9223372036854775807');
      }
    } finally { await f.close(); }
  }, 60_000);

  it("audits complete dependency IDs through the compiled CLI while keeping external prerequisites at one layer", async () => {
    const f = await fixture();
    try {
      const value: TaskGraph = {
        ...graph(), summary: { total: 2, proposed: 0, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 2 },
        tasks: [
          { ...graph().tasks[0]!, dependsOn: [secondId], externalDependsOn: [secondId], blockedBy: [secondId], ready: false },
          { ...graph().tasks[0]!, id: secondId, dependsOn: [thirdId], blockedBy: [thirdId], ready: false },
        ],
      };
      const { requests } = await f.serve((request, response) => {
        expect(Object.fromEntries(request.query)).toEqual({ taskId });
        respond(response, value);
      });
      const human = await f.invoke(["graph", taskId.toUpperCase(), "--depends-only", ...explicit]);
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toBe(`ID: ${taskId}\nDepends on: ${secondId}\nExternal dependencies: ${secondId}\n\nID: ${secondId}\nDepends on: ${thirdId}\nExternal dependencies: none\n`);
      const json = await f.invoke(["graph", taskId, "--depends-only", "--json", ...explicit]);
      expect(json.code, json.stderr).toBe(0);
      expect(parseApiJson(json.stdout)).toEqual([
        { id: taskId, dependsOn: [secondId], externalDependsOn: [secondId] },
        { id: secondId, dependsOn: [thirdId], externalDependsOn: [] },
      ]);
      expect(requests.filter(({ pathname }) => pathname.endsWith("/task-graph"))).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("soft-deletes through the compiled entrypoint with observed and explicit exact versions", async () => {
    const f = await fixture();
    try {
      const current = task({ version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "DELETE") { response.writeHead(204); response.end(); }
        else respond(response, current);
      });
      for (const { version, removeDepends } of [false, true].flatMap((removeDepends) => [undefined, "9223372036854775807"].map((version) => ({ version, removeDepends })))) {
        const before = requests.length;
        const result = await f.invoke(["delete", taskId.toUpperCase(), ...(removeDepends ? ["--remove-depends"] : []), ...(version === undefined ? [] : ["--if-version", version]), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(`Task deleted. Stored data and attachments are retained.\nID: ${taskId}\nProject: ${projectId}\n`);
        expect(requests.slice(before).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
          `GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `DELETE ${taskPath}/${taskId}`,
        ]);
        expect(requests.at(-1)!.bodyText).toBe(`{"version":${version === undefined ? current.version : version}${removeDepends ? ",\"removeDepends\":true" : ""}}`);
      }
    } finally { await f.close(); }
  }, 60_000);

  it("sets all task statuses with precise observed or supplied versions and same-status no-ops", async () => {
    const f = await fixture();
    try {
      let current = task({ requiredPlatform: "windows", description: "Status details", version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "POST") current = { ...current, assignedTo: (request.body as { assignedTo: string }).assignedTo };
        if (request.method === "PUT") {
          const { status } = request.body as { status: Task["status"] };
          if (current.status !== status) current = { ...current, status, ready: status === "todo", version: current.version + 1n };
        }
        respond(response, current, request.pathname === taskPath ? 201 : 200);
      });
      const created = await f.invoke(["create", "--title", "Status", "--status", "todo", ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain("Status: todo");
      for (const status of ["todo", "proposed", "in_progress", "done", "todo"] as const) {
        const version = current.version;
        const expectedVersion = current.status === status ? version : version + 1n;
        const before = requests.length;
        const explicitVersion = status === "in_progress";
        const result = await f.invoke(["set-status", taskId.toUpperCase(), status, ...(explicitVersion ? ["--if-version", String(version)] : []), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(`Status: ${status}`);
        expect(result.stdout).toContain(`Version: ${expectedVersion}`);
        expect(result.stdout).toContain("Description: Status details");
        expect(result.stdout).toContain("Required platform: windows");
        expect(requests.slice(before).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `PUT ${taskPath}/${taskId}/status`]);
        expect(requests.at(-1)!.body).toEqual({ version, status });
        expect(requests.at(-1)!.bodyText).toBe(`{"version":${version},"status":"${status}"}`);
      }
    } finally { await f.close(); }
  }, 60_000);

  it("lists unfinished tasks in stable global priority order and includes both terminal statuses with --all", async () => {
    const f = await fixture();
    try {
      const identifiedTask = (suffix: string, title: string, partial: Partial<Task>): Task => task({ id: `b1b2c3d4-1111-4222-8333-123456789a${suffix}`, title, ...partial });
      const blockedFirst = identifiedTask("01", "Blocked first", { ready: false, dependsOn: [secondId], blockedBy: [secondId] });
      const doneFirst = identifiedTask("02", "Done first", { status: "done", ready: false });
      const readyFirst = identifiedTask("03", "Ready first", { description: "Description omitted from list JSON", version: 9_223_372_036_854_775_807n });
      const progressFirst = identifiedTask("04", "Progress first", { status: "in_progress", ready: false });
      const readySecond = identifiedTask("05", "Ready second", {});
      const progressSecond = identifiedTask("06", "Progress second", { status: "in_progress", ready: false });
      const blockedSecond = identifiedTask("07", "Blocked second", { ready: false, dependsOn: [thirdId], blockedBy: [thirdId] });
      const doneSecond = identifiedTask("08", "Done second", { status: "done", ready: false });
      const cancelledFirst = identifiedTask("09", "Cancelled first", { status: "cancelled", cancelledAt: time, ready: false });
      const cancelledSecond = identifiedTask("10", "Cancelled second", { status: "cancelled", cancelledAt: time, ready: false });
      const proposedFirst = identifiedTask("11", "Proposed first", { status: "proposed", ready: false, allowAgents: true });
      const proposedSecond = identifiedTask("12", "Proposed second", { status: "proposed", ready: false });
      const cursor = "next priority page+/=?";
      const { requests } = await f.serve((request, response) => respond(response, request.query.has("cursor")
        ? { items: [proposedSecond, readySecond, progressSecond, blockedSecond, doneSecond, cancelledSecond], nextCursor: null }
        : { items: [blockedFirst, doneFirst, proposedFirst, readyFirst, progressFirst, cancelledFirst], nextCursor: cursor }));
      const unfinished = [progressFirst, progressSecond, readyFirst, readySecond, blockedFirst, blockedSecond, proposedFirst, proposedSecond];
      for (const includeAll of [false, true]) {
        const args = ["list", ...(includeAll ? ["--all"] : []), ...explicit];
        const expected = includeAll ? [...unfinished, doneFirst, cancelledFirst, doneSecond, cancelledSecond] : unfinished;
        const json = await f.invoke([...args, "--json"]);
        expect(json.code, json.stderr).toBe(0);
        const listed = parseApiJson(json.stdout) as Record<string, unknown>[];
        expect(listed).toEqual(expected.map(taskListItem));
        for (const item of listed) expect(item).not.toHaveProperty("description");
        expect(json.stdout.endsWith("\n")).toBe(true);
        expect(json.stdout).toContain('"version":9223372036854775807');
        const text = await f.invoke(args);
        expect(text.code, text.stderr).toBe(0);
        expect(text.stdout.match(/^Title: .*$/gm)).toEqual(expected.map(({ title }) => `Title: ${title}`));
        for (const field of ["Description:", "Version:", "Created:", "Updated:"]) expect(text.stdout).not.toContain(field);
        expect(text.stdout).toContain(`Depends on: ${secondId}`);
        expect(text.stdout).toContain(`Blocked by: ${thirdId}`);
      }
      expect(requests.filter(({ pathname }) => pathname === taskPath).map(({ query }) => Object.fromEntries(query))).toEqual(Array.from({ length: 4 }, () => [
        { limit: "100", include: "session" }, { limit: "100", include: "session", cursor },
      ]).flat());
    } finally { await f.close(); }
  }, 60_000);

  it("preserves Task timestamps in JSON and shows Session observation times in text", async () => {
    const f = await fixture();
    try {
      const completed = task({ status: "done", ready: false, startedAt: "2026-10-19T23:00:00Z", completedAt: time, cancelledAt: null });
      const value: TaskGraph = {
        observedAt: time, project,
        summary: { total: 1, proposed: 0, todo: 0, inProgress: 0, done: 1, cancelled: 0, ready: 0, blocked: 0 },
        tasks: [{ ...graph().tasks[0]!, status: "done", ready: false, startedAt: completed.startedAt, completedAt: completed.completedAt, cancelledAt: null }],
      };
      await f.serve((request, response) => respond(response, request.pathname.endsWith("/task-graph") ? value
        : request.pathname === taskPath ? { items: [completed], nextCursor: null } : completed));
      const shown = await f.invoke(["show", taskId, "--json", ...explicit]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(parseApiJson(shown.stdout)).toEqual(withTaskObservation(completed));
      const listed = await f.invoke(["list", "--all", "--json", ...explicit]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(parseApiJson(listed.stdout)).toEqual([taskListItem(completed)]);
      const graphed = await f.invoke(["graph", taskId, "--json", ...explicit]);
      expect(graphed.code, graphed.stderr).toBe(0);
      expect(parseApiJson(graphed.stdout)).toEqual(withGraphObservations(value, taskId));
      const text = await f.invoke(["list", "--all", ...explicit]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).not.toMatch(/Started:|Completed:/);
    } finally { await f.close(); }
  }, 60_000);

  it("rejects unknown status resources and filters", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((_request, response) => respond(response, { ...task(), status: "unknown", ready: false }));
      const shown = await f.invoke(["show", taskId, ...explicit]);
      expect(shown.code).toBe(1);
      expect(shown.stdout).toBe("");
      const before = requests.length;
      for (const args of [["list", "--status", "unknown"], ["set-status", taskId, "unknown"], ...["approve", "unapprove", "claim", "complete"].map((action) => [action, taskId])]) {
        const result = await f.invoke([...args, ...explicit]);
        expect(result.code).toBe(2);
      }
      expect(requests).toHaveLength(before);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps explicit status and readiness filters conjunctive with unfinished and all-state lists", async () => {
    const f = await fixture();
    try {
      const readyTask = task();
      const progressTask = task({ id: secondId, status: "in_progress", ready: false });
      const doneTask = task({ id: thirdId, status: "done", ready: false });
      const cancelledTask = task({ id: "dddddddd-4444-4444-8444-444444444444", status: "cancelled", cancelledAt: time, ready: false });
      const items = [doneTask, readyTask, progressTask, cancelledTask];
      const { requests } = await f.serve((request, response) => respond(response, {
        items: items.filter((item) => (!request.query.has("status") || item.status === request.query.get("status")) && (!request.query.has("ready") || item.ready)),
        nextCursor: null,
      }));
      const cases: readonly { args: readonly string[]; expected: readonly Task[]; query: Record<string, string> }[] = [
        { args: ["--status", "done"], expected: [doneTask], query: { status: "done", limit: "100" } },
        { args: ["--status", "cancelled"], expected: [cancelledTask], query: { status: "cancelled", limit: "100" } },
        { args: ["--ready"], expected: [readyTask], query: { ready: "true", limit: "100" } },
        { args: ["--all", "--ready"], expected: [readyTask], query: { ready: "true", limit: "100" } },
        { args: ["--status", "todo", "--ready"], expected: [readyTask], query: { status: "todo", ready: "true", limit: "100" } },
        { args: ["--status", "in_progress", "--ready"], expected: [], query: { status: "in_progress", ready: "true", limit: "100" } },
        { args: ["--status", "done", "--ready"], expected: [], query: { status: "done", ready: "true", limit: "100" } },
        { args: ["--status", "cancelled", "--ready"], expected: [], query: { status: "cancelled", ready: "true", limit: "100" } },
      ];
      const output = await f.invokeBatch(cases.map(({ args }) => ["list", ...args, "--json", ...explicit]));
      expect(requests.map(({ pathname }) => pathname)).toEqual(cases.map(() => taskPath));
      for (const [index, { expected, query }] of cases.entries()) {
        const result = output[index]!;
        expect(result.code, result.stderr).toBe(0);
        const listed = parseApiJson(result.stdout) as Record<string, unknown>[];
        expect(listed).toEqual(expected.map(taskListItem));
        for (const item of listed) expect(item).not.toHaveProperty("description");
        expect(Object.fromEntries(requests[index]!.query)).toEqual({ ...query, include: "session" });
      }
    } finally { await f.close(); }
  }, 60_000);

  it("prints empty text and JSON when only terminal tasks remain", async () => {
    const f = await fixture();
    try {
      await f.serve((_request, response) => respond(response, { items: [task({ status: "done", ready: false }), task({ id: secondId, status: "cancelled", cancelledAt: time, ready: false })], nextCursor: null }));
      const text = await f.invoke(["list", ...explicit]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toBe("No tasks.\n");
      const json = await f.invoke(["list", "--json", ...explicit]);
      expect(json.code, json.stderr).toBe(0);
      expect(parseApiJson(json.stdout)).toEqual([]);
      expect(json.stdout).toBe("[]\n");
    } finally { await f.close(); }
  }, 60_000);

  it("preserves raw property values through setting, current-value reads, task reads and removal", async () => {
    const f = await fixture();
    try {
      const supplied = [{ url: "", title: "" }, { url: "-arbitrary=a,b", title: " 标题\n\u001b[2J " }, { url: "-arbitrary=a,b", title: " 标题\n\u001b[2J " }, { url: "\0not a URL", title: "\0" }];
      const valueText = JSON.stringify(supplied);
      let current = task({ title: "Task 中文\n\u001b[2J", description: "Full description\n\u001b[2J", properties: { future: { version: 7 } }, version: 9_007_199_254_740_993n });
      let conflict = false;
      const resource = () => ({ projectId, taskId, version: current.version, properties: current.properties });
      const { requests } = await f.serve((request, response) => {
        if (request.pathname === `${taskPath}/${taskId}/properties`) respond(response, resource());
        else if (request.pathname === `${taskPath}/${taskId}/properties/pullRequests`) {
          if (conflict) { refuse(response, "version_conflict", "property-conflict", 409); return; }
          const input = request.body as { version: bigint; valueText?: string };
          const properties = Object.fromEntries(Object.entries(current.properties).filter(([name]) => name !== "pullRequests"));
          current = { ...current, version: input.version + 1n, properties: request.method === "DELETE" ? properties : { ...properties, pullRequests: JSON.parse(input.valueText!) } };
          respond(response, resource());
        } else if (request.pathname === taskPath) respond(response, { items: [current], nextCursor: null });
        else respond(response, current);
      });
      const set = await f.invoke(["set-property", taskId, "pullRequests", valueText, ...explicit]);
      expect(set.code, set.stderr).toBe(0);
      expect(requests.map(({ method, pathname }) => [method, pathname])).toEqual([
        ["GET", `${taskPath}/${taskId}/properties`], ["PUT", `${taskPath}/${taskId}/properties/pullRequests`],
      ]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, valueText });
      expect(set.stdout).toContain("Task property set.");
      expect(set.stdout).toContain('"url":"\\u0000not a URL","title":"\\u0000"');
      expect(set.stdout).not.toContain("Description:");
      const values = await f.invoke(["properties", taskId, "--json", ...explicit]);
      expect(values.code, values.stderr).toBe(0); expect(parseApiJson(values.stdout)).toEqual(resource());
      const reads = [["show", taskId], ["list"]];
      const output = await f.invokeBatch(reads.flatMap(command => [[...command, "--json", ...explicit], [...command, ...explicit]]));
      for (const [index, command] of reads.entries()) {
        const json = output[index * 2]!;
        expect(json.code, json.stderr).toBe(0);
        const parsed = parseApiJson(json.stdout);
        expect(parsed).toEqual(command[0] === "list" ? [taskListItem(current)] : withTaskObservation(current));
        if (command[0] === "list") expect((parsed as Record<string, unknown>[])[0]).not.toHaveProperty("description");
        else expect(parsed).toHaveProperty("description", current.description);
        expect(json.stdout).toContain(`"version":${current.version}`);
        const text = output[index * 2 + 1]!;
        expect(text.code, text.stderr).toBe(0);
        expect(text.stdout).toContain(" 标题\\n\\u001b[2J "); expect(text.stdout).toContain("\\u0000not a URL");
        expect(text.stdout).toContain('future: {"version":7}'); expect(text.stdout).not.toContain("\u001b");
      }
      const clearAt = requests.length;
      const clearVersion = current.version;
      const cleared = await f.invoke(["set-property", taskId, "pullRequests", "[]", "--if-version", String(clearVersion), ...explicit]);
      expect(cleared.code, cleared.stderr).toBe(0); expect(cleared.stdout).toContain("pullRequests: []");
      expect(requests.slice(clearAt).map(({ method }) => method)).toEqual(["PUT"]);
      expect(requests.at(-1)!.body).toEqual({ version: clearVersion, valueText: "[]" });
      const removeAt = requests.length;
      const removed = await f.invoke(["remove-property", taskId, "pullRequests", "--if-version", String(current.version), ...explicit]);
      expect(removed.code, removed.stderr).toBe(0); expect(removed.stdout).toContain("Task property removed.");
      expect(removed.stdout).not.toContain("pullRequests:"); expect(requests.slice(removeAt).map(({ method }) => method)).toEqual(["DELETE"]);
      expect(current.properties).toEqual({ future: { version: 7 } });
      conflict = true;
      const conflictAt = requests.length;
      const refused = await f.invoke(["set-property", taskId, "pullRequests", valueText, ...explicit]);
      expect(refused.code).toBe(1); expect(refused.stdout).toBe(""); expect(refused.stderr).toContain("property-conflict");
      expect(requests.slice(conflictAt).map(({ method }) => method)).toEqual(["GET", "PUT"]);
    } finally { await f.close(); }
  }, 60_000);

  it("defaults creation to the signed-in account and skips identity lookup for an explicit assignee", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((request, response) => respond(response, task({ assignedTo: (request.body as { assignedTo: string }).assignedTo, status: "proposed", ready: false }), 201));
      const created = await f.invoke(["create", "--title", "My task", ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain(`Assigned to: ${accountId}\n`);
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, "GET /api/v1/me", `POST ${taskPath}`]);
      expect(requests.at(-1)!.body).toEqual({ title: "My task", assignedTo: accountId });
      requests.length = 0;
      const assigned = await f.invoke(["create", "--title", "Colleague task", "--assigned-to", secondId.toUpperCase(), ...explicit]);
      expect(assigned.code, assigned.stderr).toBe(0);
      expect(assigned.stdout).toContain(`Assigned to: ${secondId}\n`);
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `POST ${taskPath}`]);
      expect(requests.at(-1)!.body).toEqual({ title: "Colleague task", assignedTo: secondId });
    } finally { await f.close(); }
  });

  it("sends complete dependency classifications while preserving omitted fields through the compiled entrypoint", async () => {
    const f = await fixture();
    try {
      const current = task({ version: 9_007_199_254_740_993n, dependsOn: [secondId], externalDependsOn: [secondId] });
      const { requests } = await f.serve((request, response) => respond(response, request.method === "GET" ? current : { ...current, ...(request.method === "POST" ? { status: "proposed", ready: false } : {}), ...(request.body as object), version: request.method === "PATCH" ? 9_223_372_036_854_775_807n : current.version + 1n }, request.method === "POST" ? 201 : 200));
      const cases = [
        { args: ["create", "--title", "Mixed", "--depends-on", thirdId.toUpperCase(), "--external-depends-on", secondId], body: { title: "Mixed", assignedTo: accountId, dependsOn: [secondId, thirdId], externalDependsOn: [secondId] } },
        { args: ["update", taskId, "--external-depends-on", thirdId], body: { dependsOn: [thirdId], externalDependsOn: [thirdId] } },
        { args: ["update", taskId, "--depends-on", secondId], body: { dependsOn: [secondId], externalDependsOn: [] } },
        { args: ["update", taskId, "--clear-dependencies"], body: { dependsOn: [], externalDependsOn: [] } },
        { args: ["update", taskId, "--description", "Preserve classifications"], body: { description: "Preserve classifications" } },
      ];
      for (const { args, body } of cases) {
        requests.length = 0;
        const update = args[0] === "update";
        const result = await f.invoke([...args, ...(update ? ["--if-version", "9223372036854775807"] : []), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(requests.map(({ method }) => method)).toEqual(update ? ["PATCH"] : ["GET", "GET", "POST"]);
        expect(requests.at(-1)!.body).toEqual({ ...(update ? { version: 9_223_372_036_854_775_807n } : {}), ...body });
      }
    } finally { await f.close(); }
  }, 60_000);

  it("submits one precise PATCH using the read version or an explicit full-int64 version and compiles dependency input", async () => {
    const f = await fixture();
    try {
      let refusal: "none" | "version" | "dependencies" = "none";
      const current = task({ version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "GET") respond(response, current);
        else if (refusal === "version") refuse(response, "version_conflict", "task-version-conflict", 409);
        else if (refusal === "dependencies") refuse(response, "invalid_input", "task-dependency-input", 400);
        else respond(response, { ...current, version: current.version + 1n });
      });
      const updated = await f.invoke(["update", taskId, "--description=", "--clear-dependencies", ...explicit]);
      expect(updated.code, updated.stderr).toBe(0);
      expect(updated.stdout).toContain("Task updated.");
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `PATCH ${taskPath}/${taskId}`]);
      expect(requests[2]!.body).toEqual({ description: "", dependsOn: [], externalDependsOn: [], version: current.version });
      expect(requests[2]!.bodyText).toContain('"version":9007199254740993');

      requests.length = 0; refusal = "version";
      const conflict = await f.invoke(["set-status", taskId, "done", "--if-version", "9223372036854775807", ...explicit]);
      expect(conflict.code).toBe(1); expect(conflict.stdout).toBe("");
      expect(conflict.stderr).toContain("version_conflict"); expect(conflict.stderr).toContain("task-version-conflict");
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `PUT ${taskPath}/${taskId}/status`]);
      expect(requests[2]!.bodyText).toContain('"version":9223372036854775807');
      expect(requests[2]!.body).toEqual({ version: 9_223_372_036_854_775_807n, status: "done" });

      requests.length = 0; refusal = "dependencies";
      const rejected = await f.invoke(["update", taskId, "--if-version", "2", "--depends-on", thirdId, "--depends-on", secondId, ...explicit]);
      expect(rejected.code).toBe(1); expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain("task-dependency-input");
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`PATCH ${taskPath}/${taskId}`]);
      expect(requests[0]!.body).toEqual({ dependsOn: [secondId, thirdId], externalDependsOn: [], version: 2n });
    } finally { await f.close(); }
  }, 60_000);
});
