package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
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
	args := map[string]any{"name": "Project", "repoUrl": "https://github.com/acme/test.git", "team": "personal"}
	response, failed := call(0, "project_create", args)
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
	_, err = memberships.RemoveGrant(t.Context(), principals[0], id, principals[0].UserID, coreproject.RemoveProjectMember{Version: 1, ExpectedUserID: principals[0].UserID})
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
