package e2e_tests

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestInstalledCLIProjectParticipantsAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_project_participant_api", []string{"AU2", "AU11", "AU-V9"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		project := process.project(t, "Installed participant API")
		user := acceptanceDecode[api.User](t, process.request(context.Background(), http.MethodGet, "/api/v1/me", nil, ""), http.StatusOK)
		fixture.exec(t, "UPDATE project_grants SET version=$3 WHERE project_id=$1 AND user_id=$2", project.ID, user.ID, int64(9007199254740993))
		program := filepath.Join(cli.root, "project-participants.mjs")
		if err := os.WriteFile(program, []byte(projectParticipantsAcceptanceProgram), 0o600); err != nil {
			t.Fatal("cannot write the installed participant API caller")
		}
		for _, name := range []string{"canonical_profile", "nullable_profile"} {
			t.Run(name, func(t *testing.T) {
				profile := api.ProjectParticipantProfile{Name: user.Name, Email: user.Email, AvatarURL: user.AvatarURL}
				if name == "nullable_profile" {
					fixture.exec(t, "UPDATE users SET name=NULL,email=NULL,avatar_url=NULL WHERE id=$1", user.ID)
					profile = api.ProjectParticipantProfile{}
				}
				input, err := json.Marshal(map[string]any{
					"serverUrl": process.origin, "serverToken": process.token,
					"projectId": project.ID, "userId": user.ID,
					"profile": profile, "version": "9007199254740993",
				})
				if err != nil {
					t.Fatal("cannot encode private participant API input")
				}
				dist := filepath.Dir(receipt.EntryPath)
				result := acceptanceCLIReceive(t, cli.startProgram(t, cli.caller, program, strings.NewReader(string(input)), filepath.Join(dist, "api", "client.js"), filepath.Join(dist, "api", "operation.js")))
				if result.status != 0 || result.stderr != "" || result.stdout != "participants-api-ok\n" {
					t.Fatalf("installed participant API workflow failed (%d): %s", result.status, result.stderr)
				}
			})
		}
	})
}

const projectParticipantsAcceptanceProgram = `import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { createApiClient } = await import(pathToFileURL(process.argv[2]).href);
const { createOperation } = await import(pathToFileURL(process.argv[3]).href);
const config = JSON.parse(readFileSync(0, "utf8"));
const operation = createOperation({ limits: { totalMs: 12000, requestMs: 3000 } });
let requests = 0;
let wire;
try {
  const client = createApiClient({ serverUrl: config.serverUrl, serverToken: config.serverToken, expectedUserId: config.userId, operation, fetch: async (input, init) => {
    requests++;
    assert.equal(new URL(input).pathname, "/api/v1/projects/" + config.projectId + "/members");
    assert.equal(init.method, "GET");
    const response = await fetch(input, init);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Daynight-User-ID"), config.userId);
    wire = await response.clone().text();
    return response;
  } });
  const participants = await client.listProjectMembers(config.projectId);
  assert.equal(requests, 1);
  assert.equal(participants.length, 1);
  const participant = participants[0];
  assert.deepEqual(Object.keys(participant).sort(), ["directGrant", "effectiveRole", "profile", "userId"]);
  assert.equal(participant.userId, config.userId);
  assert.equal(participant.effectiveRole, "admin");
  assert.deepEqual(participant.profile, config.profile);
  assert.deepEqual(Object.keys(participant.profile).sort(), ["avatarUrl", "email", "name"]);
  assert.notEqual(participant.directGrant, null);
  assert.deepEqual(Object.keys(participant.directGrant).sort(), ["createdAt", "projectId", "role", "updatedAt", "userId", "version"]);
  assert.equal(participant.directGrant.projectId, config.projectId);
  assert.equal(participant.directGrant.userId, config.userId);
  assert.equal(participant.directGrant.role, "admin");
  assert.equal(participant.directGrant.version, BigInt(config.version));
  const raw = JSON.parse(wire);
  assert.deepEqual(Object.keys(raw), ["items"]);
  assert.deepEqual(Object.keys(raw.items[0]).sort(), ["directGrant", "effectiveRole", "profile", "userId"]);
  assert.deepEqual(raw.items[0].profile, config.profile);
  assert.match(wire, new RegExp('"version"\\s*:\\s*' + config.version + '(?=[,}])'));
  assert.equal(participant.directGrant.createdAt, raw.items[0].directGrant.createdAt);
  assert.equal(participant.directGrant.updatedAt, raw.items[0].directGrant.updatedAt);
} finally {
  operation.dispose();
}
process.stdout.write("participants-api-ok\n");
`
