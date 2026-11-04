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
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/google/uuid"
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
		ownerTeam := user.PersonalTeam
		ownership := project.Ownership
		profile := api.ProjectParticipantProfile{Name: user.Name, Email: user.Email, AvatarURL: user.AvatarURL}
		ordinaryID := uuid.NewString()
		participantCount := 1
		for _, name := range []string{"canonical_profile", "nullable_profile", "direct_only", "inherited_only", "mixed_sources"} {
			t.Run(name, func(t *testing.T) {
				if name == "nullable_profile" {
					fixture.exec(t, "UPDATE users SET name=NULL,email=NULL,avatar_url=NULL WHERE id=$1", user.ID)
					profile = api.ProjectParticipantProfile{}
				}
				var directRole any = "admin"
				var teamRole any = "admin"
				switch name {
				case "direct_only":
					browser := testauth.Browser(t)
					testauth.Login(t, browser, process.origin, "bob")
					response, err := browser.Get(process.origin + "/api/v1/me")
					if err != nil {
						t.Fatal("cannot read ordinary Team administrator")
					}
					var teamAdmin api.User
					decodeErr := json.NewDecoder(response.Body).Decode(&teamAdmin)
					closeErr := response.Body.Close()
					if response.StatusCode != http.StatusOK || decodeErr != nil || closeErr != nil || teamAdmin.ID == user.ID {
						t.Fatal("ordinary Team administrator is not a distinct canonical user")
					}
					browser.CloseIdleConnections()
					fixture.exec(t, "INSERT INTO teams(id,name) VALUES($1,'Installed owner')", ordinaryID)
					fixture.exec(t, "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')", ordinaryID, teamAdmin.ID)
					fixture.exec(t, "UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1", project.ID, ordinaryID)
					participantCount = 2
					ownerTeam = api.TeamRef{ID: ordinaryID, Kind: "ordinary", Name: new("Installed owner")}
					ownership = api.ProjectOwnership{TeamID: ordinaryID, Version: 2}
					teamRole = nil
				case "inherited_only":
					fixture.exec(t, "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')", ordinaryID, user.ID)
					fixture.exec(t, "DELETE FROM project_grants WHERE project_id=$1", project.ID)
					directRole = nil
				case "mixed_sources":
					fixture.exec(t, "INSERT INTO project_grants(project_id,user_id,role,version) VALUES($1,$2,'member',$3)", project.ID, user.ID, int64(9007199254740993))
					directRole = "member"
				}
				var inheritedFrom any
				if teamRole != nil {
					inheritedFrom = map[string]any{"team": ownerTeam, "role": teamRole}
				}
				input, err := json.Marshal(map[string]any{
					"serverUrl": process.origin, "serverToken": process.token,
					"projectId": project.ID, "userId": user.ID,
					"profile": profile, "version": "9007199254740993",
					"ownerTeam": ownerTeam, "ownership": ownership,
					"inheritedFrom": inheritedFrom, "directRole": directRole, "teamRole": teamRole,
					"participantCount": participantCount,
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
  assert.equal(participants.length, config.participantCount);
  const participant = participants.find(item => item.userId === config.userId);
  assert.notEqual(participant, undefined);
  assert.deepEqual(Object.keys(participant).sort(), ["directGrant", "effectiveRole", "inheritedFrom", "profile", "userId"]);
  assert.equal(participant.userId, config.userId);
  assert.equal(participant.effectiveRole, "admin");
  assert.deepEqual(participant.inheritedFrom, config.inheritedFrom);
  assert.deepEqual(participant.profile, config.profile);
  assert.deepEqual(Object.keys(participant.profile).sort(), ["avatarUrl", "email", "name"]);
  if (config.directRole === null) {
    assert.equal(participant.directGrant, null);
  } else {
    assert.notEqual(participant.directGrant, null);
    assert.deepEqual(Object.keys(participant.directGrant).sort(), ["createdAt", "projectId", "role", "updatedAt", "userId", "version"]);
    assert.equal(participant.directGrant.projectId, config.projectId);
    assert.equal(participant.directGrant.userId, config.userId);
    assert.equal(participant.directGrant.role, config.directRole);
    assert.equal(participant.directGrant.version, BigInt(config.version));
  }
  const raw = JSON.parse(wire);
  const rawParticipant = raw.items.find(item => item.userId === config.userId);
  assert.notEqual(rawParticipant, undefined);
  assert.deepEqual(Object.keys(raw).sort(), ["actorAccess", "items"]);
  assert.deepEqual(Object.keys(raw.actorAccess).sort(), ["canTransfer", "directGrant", "effectiveRole", "ownerTeam", "ownership", "projectId", "teamRole"]);
  assert.equal(raw.actorAccess.projectId, config.projectId);
  assert.deepEqual(raw.actorAccess.ownerTeam, config.ownerTeam);
  assert.deepEqual(raw.actorAccess.ownership, config.ownership);
  assert.equal(raw.actorAccess.effectiveRole, "admin");
  assert.equal(raw.actorAccess.teamRole, config.teamRole);
  assert.equal(raw.actorAccess.canTransfer, config.teamRole === "admin");
  assert.equal(raw.actorAccess.directGrant?.role ?? null, config.directRole);
  assert.deepEqual(rawParticipant.inheritedFrom, participant.inheritedFrom);
  assert.deepEqual(Object.keys(rawParticipant).sort(), ["directGrant", "effectiveRole", "inheritedFrom", "profile", "userId"]);
  assert.deepEqual(rawParticipant.profile, config.profile);
  if (config.directRole !== null) {
    assert.match(wire, new RegExp('"version"\\s*:\\s*' + config.version + '(?=[,}])'));
    assert.equal(participant.directGrant.createdAt, rawParticipant.directGrant.createdAt);
    assert.equal(participant.directGrant.updatedAt, rawParticipant.directGrant.updatedAt);
  }
} finally {
  operation.dispose();
}
process.stdout.write("participants-api-ok\n");
`
