package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestInstalledWorkerClientAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_worker_internal_api", []string{"W-04", "W-08"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		project := process.project(t, "Worker internal API")
		task := process.task(t, project, "Worker API execution")
		task = process.update(t, task, map[string]any{"allowAgents": true})
		program := filepath.Join(cli.root, "worker-client.mjs")
		if err := os.WriteFile(program, []byte(workerClientAcceptanceProgram), 0o600); err != nil {
			t.Fatal("cannot write the installed API-client caller")
		}
		input, err := json.Marshal(map[string]string{"serverUrl": process.origin, "serverToken": process.token, "projectId": project.ID, "taskId": task.ID})
		if err != nil {
			t.Fatal("cannot encode private API-client input")
		}
		dist := filepath.Dir(receipt.EntryPath)
		result := acceptanceCLIReceive(t, cli.startProgram(t, cli.caller, program, strings.NewReader(string(input)), filepath.Join(dist, "api", "client.js"), filepath.Join(dist, "api", "operation.js")))
		if result.status != 0 || result.stderr != "" || result.stdout != "worker-api-ok\n" {
			t.Fatalf("installed internal API-client workflow failed (%d): %s", result.status, result.stderr)
		}
		finished := acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodGet, acceptanceTaskPath(task), nil, "worker-api-final"), http.StatusOK)
		if finished.Status != "done" || acceptanceWorker(t, finished.Properties) == nil || acceptanceWorker(t, finished.Properties).State != "completed" || finished.AllowAgents || len(acceptancePullRequests(t, finished.Properties)) != 1 {
			t.Fatal("installed internal API-client workflow did not persist completion and PR evidence")
		}
	})
}

const workerClientAcceptanceProgram = `import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { createApiClient } = await import(pathToFileURL(process.argv[2]).href);
const { createOperation } = await import(pathToFileURL(process.argv[3]).href);
const config = JSON.parse(readFileSync(0, "utf8"));
const { projectId, taskId } = config;
const call = async (action, transport) => {
  const operation = createOperation({ limits: { totalMs: 12000, requestMs: 3000 } });
  try {
    return await action(createApiClient({ serverUrl: config.serverUrl, serverToken: config.serverToken, operation, ...(transport === undefined ? {} : { fetch: transport }) }));
  } finally { operation.dispose(); }
};
let task = await call(api => api.getTask(projectId, taskId));
assert.equal(Object.hasOwn(task.properties, "worker"), false);
const descriptor = { claimId: randomUUID(), workerId: randomUUID(), machine: { id: randomUUID(), name: "Acceptance worker" }, platform: "linux", agent: "codex", worktreeId: randomUUID() };
let claimRequests = 0;
await assert.rejects(call(api => api.claimWorkerTask(projectId, taskId, { version: task.version, ...descriptor }), async (input, init) => {
  const response = await fetch(input, init);
  claimRequests++;
  assert.equal(response.status, 200);
  await response.text();
  throw new Error("Injected lost claim response after committed mutation");
}), error => error.outcomeUnconfirmed === true);
assert.equal(claimRequests, 1);
task = await call(api => api.getTask(projectId, taskId));
assert.equal(task.properties.worker.claimId, descriptor.claimId);
assert.equal(task.properties.worker.worktreeId, descriptor.worktreeId);
assert.equal(task.properties.worker.state, "active");
task = await call(api => api.updateTask(projectId, taskId, { version: task.version, properties: { pullRequests: [{ url: "opaque\u0000reference", title: "Delivery evidence" }] } }));
task = await call(api => api.updateWorkerClaim(projectId, taskId, { version: task.version, claimId: descriptor.claimId, phase: "executing", herdr: { session: "w", workspaceId: "workspace", paneId: "pane" }, nativeSessionId: "native" }));
assert.equal(task.properties.worker.nativeSessionId, "native");
task = await call(api => api.withdrawWorkerClaim(projectId, taskId, { version: task.version, claimId: descriptor.claimId }));
assert.equal(Object.hasOwn(task.properties, "worker"), false);
assert.equal(task.status, "todo");
assert.equal(task.allowAgents, false);
assert.equal(task.startedAt, null);
assert.equal(task.completedAt, null);
await assert.rejects(call(api => api.updateWorkerClaim(projectId, taskId, { version: task.version, claimId: descriptor.claimId, phase: "executing" })), error => error.code === "claim_conflict");
task = await call(api => api.updateTask(projectId, taskId, { version: task.version, allowAgents: true }));
const secondId = randomUUID();
task = await call(api => api.claimWorkerTask(projectId, taskId, { version: task.version, ...descriptor, claimId: secondId, worktreeId: randomUUID() }));
task = await call(api => api.releaseWorkerClaim(projectId, taskId, { version: task.version, claimId: secondId, stoppedConfirmed: true }));
assert.equal(task.properties.worker.state, "released");
task = await call(api => api.updateTask(projectId, taskId, { version: task.version, allowAgents: false, requiredPlatform: "windows" }));
const resumedId = randomUUID();
task = await call(api => api.resumeWorkerTask(projectId, taskId, { version: task.version, ...descriptor, claimId: resumedId, previousClaimId: secondId, worktreeId: randomUUID(), agent: "copilot" }));
assert.equal(task.properties.worker.claimId, resumedId);
assert.notEqual(task.properties.worker.worktreeId, descriptor.worktreeId);
assert.equal(task.properties.worker.agent, "copilot");
assert.equal(task.properties.worker.nativeSessionId, null);
assert.equal(task.properties.worker.platform, "linux");
assert.equal(task.allowAgents, false);
assert.equal(task.requiredPlatform, "windows");
await assert.rejects(call(api => api.setTaskStatus(projectId, taskId, { version: task.version, status: "done" })), error => error.code === "claim_conflict");
task = await call(api => api.completeWorkerTask(projectId, taskId, { version: task.version, claimId: resumedId }));
assert.equal(task.status, "done");
assert.equal(task.properties.worker.state, "completed");
assert.equal(task.properties.pullRequests[0].url, "opaque\u0000reference");
process.stdout.write("worker-api-ok\n");
`
