package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPProjectProductionLifecycle(t *testing.T) {
	actors := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	personal := []string{"e5555555-5555-4555-8555-555555555555", "f6666666-6666-4666-8666-666666666666"}
	org := newMCPOrgFixture(t)
	production, _ := newMCPOperationServer(t, map[string]model.Principal{tokens[0]: actors[0], tokens[1]: actors[1]}, attachmentTestFiles(t), func(app *service.App) {
		org.configure(app)
		org.bindIdentity(app.Identity.(*mcpOperationIdentity), actors, personal, 8)
	})
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
	prepareRepository := func(p model.Principal, name, repo string, v model.Project, matching bool, team string) {
		t.Helper()
		mcpOrgRepository(t, org, p, projectcore.CreateProject{Name: name, RepoURL: repo, TeamID: &team, ExpectedUserID: p.UserID}, !matching, v, !matching, nil)
	}
	unicodeTeam := mcpOrgTeam(t, "b8888888-8888-4888-8888-888888888888", strings.Repeat("😀", 256), actors[0].UserID)
	mcpOrgCreateTeam(t, org, actors[0], unicodeTeam)
	teamResponse, failed := call(0, "team_create", map[string]any{"name": *unicodeTeam.Name, "confirm": true})
	if failed || obj(teamResponse["data"])["id"] != unicodeTeam.ID {
		t.Fatalf("boundary Team: %+v", teamResponse)
	}
	teamID := unicodeTeam.ID
	asciiName := strings.Repeat("a", 256)
	mcpOrgCreateTeam(t, org, actors[0], mcpOrgTeam(t, "c9999999-9999-4999-8999-999999999999", asciiName, actors[0].UserID))
	if response, failed := call(0, "team_create", map[string]any{"name": asciiName, "confirm": true}); failed {
		t.Fatalf("256-code-point Team: %+v", response)
	}
	asciiProject := projectHTTPRecord("d0000000-0000-4000-8000-000000000000", asciiName, "host:boundary", personal[0])
	prepareRepository(actors[0], asciiName, "host:boundary", asciiProject, false, personal[0])
	if response, failed := call(0, "project_create", map[string]any{"name": asciiName, "repoUrl": "host:boundary", "team": "personal", "confirm": true}); failed {
		t.Fatalf("256-code-point Project: %+v", response)
	}
	prefix := "https://example.com/"
	maxURL := prefix + strings.Repeat("r", 4096-len(prefix))
	maxProject := projectHTTPRecord("e0000000-0000-4000-8000-000000000000", strings.Repeat("😀", 256), maxURL, personal[0])
	maxArgs := map[string]any{"name": maxProject.Name, "repoUrl": maxURL, "team": "personal", "confirm": true}
	prepareRepository(actors[0], maxProject.Name, maxURL, maxProject, false, personal[0])
	createdMax, failed := call(0, "project_create", maxArgs)
	if failed {
		t.Fatalf("boundary Project: %+v", createdMax)
	}
	maxID := obj(obj(createdMax["data"])["project"])["id"]
	delete(maxArgs, "confirm")
	prepareRepository(actors[0], maxProject.Name, maxURL, maxProject, true, personal[0])
	reusedMax, failed := call(0, "project_create", maxArgs)
	if failed || obj(reusedMax["data"])["created"] != false || obj(obj(reusedMax["data"])["project"])["id"] != maxID {
		t.Fatalf("boundary repository reuse: %+v", reusedMax)
	}
	for _, name := range []string{strings.Repeat("a", 257), strings.Repeat("😀", 256) + "a"} {
		for _, request := range []struct {
			tool string
			args map[string]any
		}{{"team_create", map[string]any{"name": name, "confirm": true}}, {"team_rename", map[string]any{"team": teamID, "name": name, "ifVersion": "1", "confirm": true}}, {"project_create", map[string]any{"name": name, "repoUrl": "host:repo", "team": "personal", "confirm": true}}} {
			invalid := &model.Fault{Code: "invalid_input", Message: "Name must contain at most 256 code points."}
			switch request.tool {
			case "team_create":
				mcpOrgTeamCreateResult(t, org, actors[0], teamcore.CreateTeam{Name: name, ExpectedUserID: actors[0].UserID}, model.Team{}, invalid)
			case "team_rename":
				mcpOrgTeamRead(t, org, actors[0], unicodeTeam)
				mcpOrgTeamRename(t, org, actors[0], teamID, teamcore.ChangeTeam{Name: name, Version: 1, ExpectedUserID: actors[0].UserID}, model.Team{}, invalid)
			case "project_create":
				team := personal[0]
				mcpOrgRepository(t, org, actors[0], projectcore.CreateProject{Name: name, RepoURL: "host:repo", TeamID: &team, ExpectedUserID: actors[0].UserID}, true, model.Project{}, false, invalid)
			}
			response, failed := call(0, request.tool, request.args)
			if !failed || obj(response["error"])["code"] != "invalid_input" {
				t.Fatalf("%s: %+v", request.tool, response)
			}
		}
	}
	teamForOversized := personal[0]
	mcpOrgRepository(t, org, actors[0], projectcore.CreateProject{Name: "Project", RepoURL: maxURL + "r", TeamID: &teamForOversized, ExpectedUserID: actors[0].UserID}, true, model.Project{}, false, &model.Fault{Code: "invalid_input", Message: "Repository URL is too long."})
	response, failed := call(0, "project_create", map[string]any{"name": "Project", "repoUrl": maxURL + "r", "team": "personal", "confirm": true})
	if !failed || obj(response["error"])["code"] != "invalid_input" {
		t.Fatalf("oversized repository: %+v", response)
	}
	project := projectHTTPRecord("f0000000-0000-4000-8000-000000000000", "Project", "https://github.com/acme/test.git", personal[0])
	args := map[string]any{"name": project.Name, "repoUrl": project.RepoURL, "team": "personal"}
	teamForConfirmation := personal[0]
	mcpOrgRepository(t, org, actors[0], projectcore.CreateProject{Name: project.Name, RepoURL: project.RepoURL, TeamID: &teamForConfirmation, ExpectedUserID: actors[0].UserID}, false, model.Project{}, false, &model.Fault{Code: "invalid_input", Message: "Confirmation is required."})
	response, failed = call(0, "project_create", args)
	if !failed || obj(response["error"])["code"] != "invalid_input" {
		t.Fatalf("confirmation: %+v", response)
	}
	args["confirm"] = true
	prepareRepository(actors[0], project.Name, project.RepoURL, project, false, personal[0])
	response, failed = call(0, "project_create", args)
	if failed {
		t.Fatalf("create: %+v", response)
	}
	data := obj(response["data"])
	id := obj(data["project"])["id"].(string)
	if data["created"] != true || id != project.ID {
		t.Fatalf("create receipt: %+v", data)
	}
	prepareRepository(actors[0], "Different", "git@github.com:acme/test.git", project, true, target.ID)
	response, failed = call(0, "project_create", map[string]any{"name": "Different", "repoUrl": "git@github.com:acme/test.git", "team": target.ID})
	if failed || obj(response["data"])["created"] != false || obj(obj(response["data"])["project"])["id"] != id {
		t.Fatalf("reuse: %+v", response)
	}
	previewResult := projectcore.TransferPreview{SourceTeam: model.TeamRef{ID: personal[0], Kind: "personal"}, TargetTeam: mcpOrgCopyTeamRef(target.TeamRef), Ownership: project.Ownership, TargetTeamVersion: 1}
	preparePreview := func(actor model.Principal, preview projectcore.TransferPreview, accessErr error) {
		t.Helper()
		called := org.expect("Projects.TransferPreview")
		preview = mcpOrgCopyPreview(preview)
		org.projects.TransferPreviewCall = func(ctx context.Context, p model.Principal, projectID, to string) (projectcore.TransferPreview, error) {
			called()
			org.check(ctx, p, actor, []string{projectID, to}, []string{id, target.ID})
			return mcpOrgCopyPreview(preview), accessErr
		}
	}
	preparePreview(actors[1], projectcore.TransferPreview{}, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound})
	response, failed = call(1, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "confirm": true})
	if !failed {
		t.Fatalf("unauthorized transfer: %+v", response)
	}
	preparePreview(actors[0], previewResult, nil)
	staleOwnership := project.Ownership
	staleOwnership.Version = 999
	mcpOrgTransfer(t, org, actors[0], id, projectcore.TransferInput{Ownership: staleOwnership, TargetTeam: projectcore.TeamVersion{ID: target.ID, Version: 1}, ExpectedUserID: actors[0].UserID}, projectcore.TransferReceipt{}, &model.Fault{Code: "version_conflict", Message: "Project ownership has changed."})
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "ifVersion": "999", "confirm": true})
	if !failed || obj(response["error"])["code"] != "version_conflict" {
		t.Fatalf("stale transfer: %+v", response)
	}
	preparePreview(actors[0], previewResult, nil)
	nextOwnership := model.ProjectOwnership{TeamID: target.ID, Version: 2, UpdatedAt: project.UpdatedAt.Add(time.Second)}
	transferReceipt := projectcore.TransferReceipt{ProjectID: id, Changed: true, SourceTeam: model.TeamRef{ID: personal[0], Kind: "personal"}, OwnerTeam: mcpOrgCopyTeamRef(target.TeamRef), Ownership: nextOwnership, ActorAccess: nil}
	mcpOrgTransfer(t, org, actors[0], id, projectcore.TransferInput{Ownership: project.Ownership, TargetTeam: projectcore.TeamVersion{ID: target.ID, Version: 1}, ExpectedUserID: actors[0].UserID}, transferReceipt, nil)
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": origin + "/teams/" + target.ID, "confirm": true})
	if failed {
		t.Fatalf("transfer: %+v", response)
	}
	data = obj(response["data"])
	if data["changed"] != true || data["actorAccess"] != nil || obj(data["ownerTeam"])["id"] != target.ID || obj(data["ownership"])["version"] != "2" {
		t.Fatalf("transfer receipt: %+v", data)
	}
	mcpOrgGetProject(t, org, actors[0], project.ID, model.Project{}, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound})
	response, failed = call(0, "project_show", map[string]any{"projectId": id})
	if !failed || obj(response["error"])["code"] != "not_found" {
		t.Fatalf("lost access: %+v", response)
	}
	next := project
	next.Ownership = nextOwnership
	mcpOrgGetProject(t, org, actors[1], next.ID, next, nil)
	response, failed = call(1, "project_show", map[string]any{"projectId": id})
	if failed || obj(response["data"])["id"] != id {
		t.Fatalf("new owner read: %+v", response)
	}
}
