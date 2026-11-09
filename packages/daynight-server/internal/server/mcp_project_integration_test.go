package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPProjectProductionLifecycle(t *testing.T) {
	actors := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	personal := []string{"e5555555-5555-4555-8555-555555555555", "f6666666-6666-4666-8666-666666666666"}
	tx := newHTTPTestStore(t)
	mcpOrgAuthenticate(t, tx, actors, tokens, personal, 8)
	production, _ := newMCPHTTPServer(t, tx, attachmentTestFiles(t))
	origin := production.URL
	clients := []*sdk.ClientSession{mcpPATClient(t, origin, tokens[0]), mcpPATClient(t, origin, tokens[1])}
	target := mcpOrgTeam(t, "a7777777-7777-4777-8777-777777777777", "Destination", actors[1].UserID)
	call := func(who int, name string, args map[string]any) (map[string]any, bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := clients[who].CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var v map[string]any
		if err = json.Unmarshal(encoded, &v); err != nil {
			t.Fatal(err)
		}
		return v, result.IsError
	}
	obj := func(v any) map[string]any {
		t.Helper()
		m, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("expected object: %#v", v)
		}
		return m
	}
	prepareRepository := func(p model.Principal, name, repo string, v model.Project, matching bool) {
		t.Helper()
		read := projectHTTPCount(t, 1)
		mcpOrgRead(t, tx, 1, mcpOrgProjectReader{ScopedProjectsCall: func(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
			read()
			projectHTTPCheck(t, actor, p)
			projectHTTPCheck(t, scope, store.ProjectScope{Kind: store.ProjectScopeAll})
			projectHTTPCheck(t, page, store.Page{Limit: 100})
			items := []model.Project{}
			if matching {
				items = []model.Project{v}
			}
			return store.ProjectPage{Items: items}, nil
		}}, nil)
		if matching {
			return
		}
		write, lock, member, insert := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		dao := projectHTTPCreateDAO{TeamCall: func(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
			lock()
			projectHTTPCheck(t, id, personal[0])
			return store.ProjectCreationTeam{ID: id}, nil
		}, MemberCall: func(ctx context.Context, id string) (bool, error) {
			member()
			projectHTTPCheck(t, id, personal[0])
			return true, nil
		}, InsertCall: func(ctx context.Context, id, gotName, gotRepo, team string) (model.Project, model.ProjectAccess, error) {
			insert()
			if _, err := model.CanonicalID(id); err != nil {
				t.Errorf("invalid allocated Project UUID: %v", err)
			}
			projectHTTPCheck(t, gotName, name)
			projectHTTPCheck(t, gotRepo, repo)
			projectHTTPCheck(t, team, personal[0])
			return v, projectHTTPAccess(p, v), nil
		}}
		tx.WriteProjectCreationCall = func(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
			write()
			projectHTTPCheck(t, user, p.UserID)
			err := op(dao)
			if err != nil {
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		}
	}
	unicodeTeam := mcpOrgTeam(t, "b8888888-8888-4888-8888-888888888888", strings.Repeat("😀", 256), actors[0].UserID)
	mcpOrgCreateTeam(t, tx, actors[0], unicodeTeam)
	teamResponse, failed := call(0, "team_create", map[string]any{"name": *unicodeTeam.Name, "confirm": true})
	if failed || obj(teamResponse["data"])["id"] != unicodeTeam.ID {
		t.Fatalf("boundary Team: %+v", teamResponse)
	}
	teamID := unicodeTeam.ID
	asciiName := strings.Repeat("a", 256)
	mcpOrgCreateTeam(t, tx, actors[0], mcpOrgTeam(t, "c9999999-9999-4999-8999-999999999999", asciiName, actors[0].UserID))
	if response, failed := call(0, "team_create", map[string]any{"name": asciiName, "confirm": true}); failed {
		t.Fatalf("256-code-point Team: %+v", response)
	}
	asciiProject := projectHTTPRecord("d0000000-0000-4000-8000-000000000000", asciiName, "host:boundary", personal[0])
	prepareRepository(actors[0], asciiName, "host:boundary", asciiProject, false)
	if response, failed := call(0, "project_create", map[string]any{"name": asciiName, "repoUrl": "host:boundary", "team": "personal", "confirm": true}); failed {
		t.Fatalf("256-code-point Project: %+v", response)
	}
	prefix := "https://example.com/"
	maxURL := prefix + strings.Repeat("r", 4096-len(prefix))
	maxProject := projectHTTPRecord("e0000000-0000-4000-8000-000000000000", strings.Repeat("😀", 256), maxURL, personal[0])
	maxArgs := map[string]any{"name": maxProject.Name, "repoUrl": maxURL, "team": "personal", "confirm": true}
	prepareRepository(actors[0], maxProject.Name, maxURL, maxProject, false)
	createdMax, failed := call(0, "project_create", maxArgs)
	if failed {
		t.Fatalf("boundary Project: %+v", createdMax)
	}
	maxID := obj(obj(createdMax["data"])["project"])["id"]
	delete(maxArgs, "confirm")
	prepareRepository(actors[0], maxProject.Name, maxURL, maxProject, true)
	reusedMax, failed := call(0, "project_create", maxArgs)
	if failed || obj(reusedMax["data"])["created"] != false || obj(obj(reusedMax["data"])["project"])["id"] != maxID {
		t.Fatalf("boundary repository reuse: %+v", reusedMax)
	}
	tx.ReadSnapshotCall = nil
	tx.CreateTeamCall = nil
	tx.WriteTeamCall = nil
	tx.WriteProjectCreationCall = nil
	for _, name := range []string{strings.Repeat("a", 257), strings.Repeat("😀", 256) + "a"} {
		for _, request := range []struct {
			tool string
			args map[string]any
		}{{"team_create", map[string]any{"name": name, "confirm": true}}, {"team_rename", map[string]any{"team": teamID, "name": name, "ifVersion": "1", "confirm": true}}, {"project_create", map[string]any{"name": name, "repoUrl": "host:repo", "team": "personal", "confirm": true}}} {
			tx.ReadSnapshotCall = nil
			tx.WriteTeamCall = nil
			if request.tool == "team_rename" {
				read, readTeam := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
				mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(ctx context.Context, user, id string) (model.Team, error) {
					read()
					projectHTTPCheck(t, []string{user, id}, []string{actors[0].UserID, unicodeTeam.ID})
					return unicodeTeam, nil
				}})
				mcpOrgWriteTeam(t, tx, unicodeTeam.ID, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
					readTeam()
					projectHTTPCheck(t, user, actors[0].UserID)
					return unicodeTeam, nil
				}}, nil)
			}
			response, failed := call(0, request.tool, request.args)
			if !failed || obj(response["error"])["code"] != "invalid_input" {
				t.Fatalf("%s: %+v", request.tool, response)
			}
		}
	}
	response, failed := call(0, "project_create", map[string]any{"name": "Project", "repoUrl": maxURL + "r", "team": "personal", "confirm": true})
	if !failed || obj(response["error"])["code"] != "invalid_input" {
		t.Fatalf("oversized repository: %+v", response)
	}
	project := projectHTTPRecord("f0000000-0000-4000-8000-000000000000", "Project", "https://github.com/acme/test.git", personal[0])
	args := map[string]any{"name": project.Name, "repoUrl": project.RepoURL, "team": "personal"}
	read := projectHTTPCount(t, 1)
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{ScopedProjectsCall: func(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
		read()
		projectHTTPCheck(t, actor, actors[0])
		projectHTTPCheck(t, scope, store.ProjectScope{Kind: store.ProjectScopeAll})
		projectHTTPCheck(t, page, store.Page{Limit: 100})
		return store.ProjectPage{Items: []model.Project{}}, nil
	}}, nil)
	response, failed = call(0, "project_create", args)
	if !failed || obj(response["error"])["code"] != "invalid_input" {
		t.Fatalf("confirmation: %+v", response)
	}
	args["confirm"] = true
	prepareRepository(actors[0], project.Name, project.RepoURL, project, false)
	response, failed = call(0, "project_create", args)
	if failed {
		t.Fatalf("create: %+v", response)
	}
	data := obj(response["data"])
	id := obj(data["project"])["id"].(string)
	if data["created"] != true || id != project.ID {
		t.Fatalf("create receipt: %+v", data)
	}
	prepareRepository(actors[0], "Different", "git@github.com:acme/test.git", project, true)
	response, failed = call(0, "project_create", map[string]any{"name": "Different", "repoUrl": "git@github.com:acme/test.git", "team": target.ID})
	if failed || obj(response["data"])["created"] != false || obj(obj(response["data"])["project"])["id"] != id {
		t.Fatalf("reuse: %+v", response)
	}
	preparePreview := func(actor model.Principal, accessErr error) {
		t.Helper()
		access := projectHTTPCount(t, 1)
		dao := mcpOrgProjectReader{ProjectAccessCall: func(ctx context.Context, got model.Principal, projectID string) (model.ProjectAccess, error) {
			access()
			projectHTTPCheck(t, got, actor)
			projectHTTPCheck(t, projectID, id)
			return projectHTTPAccess(actor, project), accessErr
		}}
		if accessErr == nil {
			team, role := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
			dao.TransferTeamCall = func(ctx context.Context, teamID string) (store.TransferTeam, error) {
				team()
				projectHTTPCheck(t, teamID, target.ID)
				return store.TransferTeam{Ref: target.TeamRef, Version: 1}, nil
			}
			dao.TransferRoleCall = func(ctx context.Context, user, projectID, teamID string) (*model.ProjectRole, error) {
				role()
				projectHTTPCheck(t, []string{user, projectID, teamID}, []string{actor.UserID, id, target.ID})
				return nil, nil
			}
		}
		mcpOrgRead(t, tx, 1, dao, nil)
	}
	preparePreview(actors[1], model.ErrNotFound)
	response, failed = call(1, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "confirm": true})
	if !failed {
		t.Fatalf("unauthorized transfer: %+v", response)
	}
	preparePreview(actors[0], nil)
	own, teams, access := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	mcpOrgWriteProject(t, tx, id, mcpOrgProjectWriter{LockTransferOwnershipCall: func(context.Context) (model.ProjectOwnership, error) { own(); return project.Ownership, nil }, LockTransferTeamsCall: func(ctx context.Context, source, dest string) (store.TransferTeam, store.TransferTeam, error) {
		teams()
		projectHTTPCheck(t, []string{source, dest}, []string{personal[0], target.ID})
		return store.TransferTeam{Ref: model.TeamRef{ID: personal[0], Kind: "personal"}, Version: 1}, store.TransferTeam{Ref: target.TeamRef, Version: 1}, nil
	}, ProjectAccessCall: func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, actor, actors[0])
		return projectHTTPAccess(actor, project), nil
	}}, nil)
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "ifVersion": "999", "confirm": true})
	if !failed || obj(response["error"])["code"] != "version_conflict" {
		t.Fatalf("stale transfer: %+v", response)
	}
	preparePreview(actors[0], nil)
	own, teams, move, access := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 2)
	nextOwnership := model.ProjectOwnership{TeamID: target.ID, Version: 2, UpdatedAt: project.UpdatedAt.Add(time.Second)}
	accessCalls := 0
	mcpOrgWriteProject(t, tx, id, mcpOrgProjectWriter{LockTransferOwnershipCall: func(context.Context) (model.ProjectOwnership, error) { own(); return project.Ownership, nil }, LockTransferTeamsCall: func(ctx context.Context, source, dest string) (store.TransferTeam, store.TransferTeam, error) {
		teams()
		projectHTTPCheck(t, []string{source, dest}, []string{personal[0], target.ID})
		return store.TransferTeam{Ref: model.TeamRef{ID: personal[0], Kind: "personal"}, Version: 1}, store.TransferTeam{Ref: target.TeamRef, Version: 1}, nil
	}, MoveOwnershipCall: func(ctx context.Context, dest string) (model.ProjectOwnership, error) {
		move()
		projectHTTPCheck(t, dest, target.ID)
		return nextOwnership, nil
	}, ProjectAccessCall: func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, actor, actors[0])
		accessCalls++
		if accessCalls == 1 {
			prior := projectHTTPAccess(actor, project)
			prior.DirectGrant = nil
			return prior, nil
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}}, mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{ProjectID: id}))
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": origin + "/teams/" + target.ID, "confirm": true})
	if failed {
		t.Fatalf("transfer: %+v", response)
	}
	data = obj(response["data"])
	if data["changed"] != true || data["actorAccess"] != nil || obj(data["ownerTeam"])["id"] != target.ID || obj(data["ownership"])["version"] != "2" {
		t.Fatalf("transfer receipt: %+v", data)
	}
	mcpOrgGetProject(t, tx, actors[0], project, model.ErrNotFound)
	response, failed = call(0, "project_show", map[string]any{"projectId": id})
	if !failed || obj(response["error"])["code"] != "not_found" {
		t.Fatalf("lost access: %+v", response)
	}
	next := project
	next.Ownership = nextOwnership
	mcpOrgGetProject(t, tx, actors[1], next, nil)
	response, failed = call(1, "project_show", map[string]any{"projectId": id})
	if failed || obj(response["data"])["id"] != id {
		t.Fatalf("new owner read: %+v", response)
	}
}
