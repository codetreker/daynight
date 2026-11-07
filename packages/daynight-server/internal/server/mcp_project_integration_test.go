package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPProjectProductionLifecycle(t *testing.T) {
	database := projectTestStore(t)
	files := attachmentTestFiles(t)
	production := httptest.NewUnstartedServer(nil)
	origin := "http://" + production.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL, config.UniAuthURL = origin, callback, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret = gateway.AppID, gateway.AppSecret
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, err := newTestHandler(Dependencies{Store: database, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	app := handler.(*sessionApplication)
	production.Config.Handler = httpx.RequestLogging(logger, app)
	production.Start()
	t.Cleanup(func() {
		production.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
	browsers := []*sdk.ClientSession{}
	principals := []model.Principal{}
	identityClient, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.New(database, identityClient, callback)
	for _, user := range []string{"alice", "bob"} {
		browser := testauth.Browser(t)
		testauth.Login(t, browser, origin, user)
		token := testauth.CreatePAT(t, browser, origin)
		principal, err := identity.Authenticate(t.Context(), model.PATCredential, token)
		if err != nil {
			t.Fatal(err)
		}
		principals = append(principals, principal)
		browsers = append(browsers, mcpPATClient(t, origin, token))
	}
	target, err := teamservice.NewTeams(database).Create(t.Context(), principals[1], coreteam.CreateTeam{Name: "Destination", ExpectedUserID: principals[1].UserID})
	if err != nil {
		t.Fatal(err)
	}
	call := func(who int, name string, args map[string]any) (map[string]any, bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := browsers[who].CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
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
	// Exercise the same domain limits through the production MCP tools and verify
	// rejected requests leave the complete organization state untouched.
	teamResponse, failed := call(0, "team_create", map[string]any{"name": strings.Repeat("😀", 256), "confirm": true})
	if failed {
		t.Fatalf("boundary Team: %+v", teamResponse)
	}
	teamID := obj(teamResponse["data"])["id"].(string)
	asciiName := strings.Repeat("a", 256)
	if response, failed := call(0, "team_create", map[string]any{"name": asciiName, "confirm": true}); failed {
		t.Fatalf("256-code-point Team: %+v", response)
	}
	if response, failed := call(0, "project_create", map[string]any{"name": asciiName, "repoUrl": "host:boundary", "team": "personal", "confirm": true}); failed {
		t.Fatalf("256-code-point Project: %+v", response)
	}
	prefix := "https://example.com/"
	maxURL := prefix + strings.Repeat("r", 4096-len(prefix))
	maxArgs := map[string]any{"name": strings.Repeat("😀", 256), "repoUrl": maxURL, "team": "personal", "confirm": true}
	createdMax, failed := call(0, "project_create", maxArgs)
	if failed {
		t.Fatalf("boundary Project: %+v", createdMax)
	}
	maxID := obj(obj(createdMax["data"])["project"])["id"]
	delete(maxArgs, "confirm")
	reusedMax, failed := call(0, "project_create", maxArgs)
	if failed || obj(reusedMax["data"])["created"] != false || obj(obj(reusedMax["data"])["project"])["id"] != maxID {
		t.Fatalf("boundary repository reuse: %+v", reusedMax)
	}
	snapshot := func() string {
		t.Helper()
		var state string
		err := database.Pool.QueryRow(t.Context(), `SELECT jsonb_build_object('teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM teams t),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY team_id,user_id) FROM team_members m),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'ownership',(SELECT jsonb_agg(to_jsonb(o) ORDER BY project_id) FROM project_ownership o),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id,user_id) FROM project_grants g))::text`).Scan(&state)
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	for _, name := range []string{strings.Repeat("a", 257), strings.Repeat("😀", 256) + "a"} {
		for _, request := range []struct {
			tool string
			args map[string]any
		}{
			{"team_create", map[string]any{"name": name, "confirm": true}},
			{"team_rename", map[string]any{"team": teamID, "name": name, "ifVersion": "1", "confirm": true}},
			{"project_create", map[string]any{"name": name, "repoUrl": "host:repo", "team": "personal", "confirm": true}},
		} {
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
	if after := snapshot(); after != before {
		t.Fatal("rejected MCP writes changed organization rows or versions")
	}

	args := map[string]any{"name": "Project", "repoUrl": "https://github.com/acme/test.git", "team": "personal"}
	response, failed = call(0, "project_create", args)
	if !failed || obj(response["error"])["code"] != "invalid_input" {
		t.Fatalf("confirmation: %+v", response)
	}
	args["confirm"] = true
	response, failed = call(0, "project_create", args)
	if failed {
		t.Fatalf("create: %+v", response)
	}
	data := obj(response["data"])
	project := obj(data["project"])
	id := project["id"].(string)
	if data["created"] != true {
		t.Fatalf("create receipt: %+v", data)
	}
	response, failed = call(0, "project_create", map[string]any{"name": "Different", "repoUrl": "git@github.com:acme/test.git", "team": target.ID})
	if failed || obj(response["data"])["created"] != false || obj(obj(response["data"])["project"])["id"] != id {
		t.Fatalf("reuse: %+v", response)
	}
	response, failed = call(1, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "confirm": true})
	if !failed {
		t.Fatalf("unauthorized transfer: %+v", response)
	}
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "ifVersion": "999", "confirm": true})
	if !failed || obj(response["error"])["code"] != "version_conflict" {
		t.Fatalf("stale transfer: %+v", response)
	}
	memberships := projectservice.NewMemberships(database)
	var grantVersion int64
	if err := database.Pool.QueryRow(t.Context(), `SELECT version FROM project_grants WHERE project_id=$1 AND user_id=$2`, id, principals[0].UserID).Scan(&grantVersion); err != nil {
		t.Fatal(err)
	}
	_, err = memberships.RemoveGrant(t.Context(), principals[0], id, principals[0].UserID, coreproject.RemoveProjectMember{Version: grantVersion, ExpectedUserID: principals[0].UserID})
	if err != nil {
		t.Fatal(err)
	}
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": origin + "/teams/" + target.ID, "confirm": true})
	if failed {
		t.Fatalf("transfer: %+v", response)
	}
	data = obj(response["data"])
	if data["changed"] != true || data["actorAccess"] != nil || obj(data["ownerTeam"])["id"] != target.ID || obj(data["ownership"])["version"] != "2" {
		t.Fatalf("transfer receipt: %+v", data)
	}
	response, failed = call(0, "project_show", map[string]any{"projectId": id})
	if !failed || obj(response["error"])["code"] != "not_found" {
		t.Fatalf("lost access: %+v", response)
	}
	response, failed = call(1, "project_show", map[string]any{"projectId": id})
	if failed || obj(response["data"])["id"] != id {
		t.Fatalf("new owner read: %+v", response)
	}
}
