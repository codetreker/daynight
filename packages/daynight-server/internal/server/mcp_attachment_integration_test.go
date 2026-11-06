package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPAttachmentProductionLifecycle(t *testing.T) {
	database := projectTestStore(t)
	production := httptest.NewUnstartedServer(nil)
	origin := "http://" + production.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL, config.UniAuthURL = origin, callback, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret = gateway.AppID, gateway.AppSecret
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := attachmentTestFiles(t)
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
			t.Error(err)
		}
	})
	identityClient, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.New(database, identityClient, callback)
	var principal model.Principal
	var tokens []string
	for _, user := range []string{"alice", "bob"} {
		browser := testauth.Browser(t)
		testauth.Login(t, browser, origin, user)
		token := testauth.CreatePAT(t, browser, origin)
		p, err := identity.Authenticate(t.Context(), model.PATCredential, token)
		if err != nil {
			t.Fatal(err)
		}
		if user == "alice" {
			principal = p
		}
		tokens = append(tokens, token)
	}
	alice, bob := mcpPATClient(t, origin, tokens[0]), mcpPATClient(t, origin, tokens[1])
	call := func(client *sdk.ClientSession, name string, args map[string]any, failure bool) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError != failure {
			t.Fatalf("%s: result=%+v error=%v", name, result, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err = json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	obj := func(value any) map[string]any {
		t.Helper()
		out, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("not an object: %#v", value)
		}
		return out
	}
	project := call(alice, "project_create", map[string]any{"name": "MCP attachments", "repoUrl": "https://example.com/attachments", "team": "personal", "confirm": true}, false)
	projectID := obj(obj(project["data"])["project"])["id"].(string)
	tasks := taskservice.NewTasks(database)
	parent, err := tasks.Create(t.Context(), principal, projectID, taskcore.CreateTask{Title: "Attachments"})
	if err != nil {
		t.Fatal(err)
	}
	attachments := attachmentservice.NewAttachments(database, database, files)
	for _, path := range []string{"a", "b", "c"} {
		if _, _, err := attachments.Put(t.Context(), principal, projectID, parent.ID, path, "text/plain", strings.NewReader("body-"+path)); err != nil {
			t.Fatal(err)
		}
	}
	args := map[string]any{"projectId": projectID, "taskId": parent.ID, "limit": 2}
	denied := call(bob, "task_attachment_list", args, true)
	if obj(denied["error"])["code"] != "not_found" {
		t.Fatalf("denied: %+v", denied)
	}
	first := obj(call(alice, "task_attachment_list", args, false)["data"])
	items := first["items"].([]any)
	if len(items) != 2 || obj(items[0])["path"] != "a" || obj(items[1])["path"] != "b" {
		t.Fatalf("page: %+v", first)
	}
	args["cursor"] = first["nextCursor"]
	tail := obj(call(alice, "task_attachment_list", args, false)["data"])
	if len(tail["items"].([]any)) != 1 || obj(tail["items"].([]any)[0])["path"] != "c" || tail["nextCursor"] != nil {
		t.Fatalf("tail: %+v", tail)
	}
	remove := map[string]any{"projectId": projectID, "taskId": parent.ID, "path": "b"}
	if obj(call(bob, "task_attachment_remove", remove, true)["error"])["code"] != "not_found" {
		t.Fatal("unauthorized remove")
	}
	if obj(call(alice, "task_attachment_remove", remove, false)["data"])["removed"] != true {
		t.Fatal("missing remove receipt")
	}
	if _, _, err := attachments.Open(t.Context(), principal, projectID, parent.ID, "b"); err == nil {
		t.Fatal("deleted attachment still opens")
	}
	after, err := tasks.Get(t.Context(), principal, projectID, parent.ID)
	if err != nil || after.Version != parent.Version || !after.UpdatedAt.Equal(parent.UpdatedAt) {
		t.Fatalf("attachment modified task: %+v %v", after, err)
	}
	if _, _, err := attachments.Put(t.Context(), principal, projectID, parent.ID, "giant", "text/plain; x="+strings.Repeat("a", 100000), strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	page := obj(call(alice, "task_attachment_list", map[string]any{"projectId": projectID, "taskId": parent.ID, "limit": 2}, false)["data"])
	oversized := obj(call(alice, "task_attachment_list", map[string]any{"projectId": projectID, "taskId": parent.ID, "cursor": page["nextCursor"]}, true)["error"])
	refs := obj(oversized["refs"])
	if oversized["code"] != "resource_conflict" || refs["path"] != "giant" || refs["projectId"] != projectID || refs["taskId"] != parent.ID || refs["restListPath"] == nil || refs["nextCursor"] == nil {
		t.Fatalf("oversized metadata: %+v", oversized)
	}
	message := oversized["message"].(string)
	if !strings.Contains(message, "PAT or browser session") || !strings.Contains(message, "MCP OAuth access tokens cannot authenticate REST") {
		t.Fatalf("REST credential guidance: %s", message)
	}
	found := false
	var restCursor *string
	pages := 0
	for {
		address := origin + refs["restListPath"].(string) + "?limit=1"
		if restCursor != nil {
			address += "&cursor=" + url.QueryEscape(*restCursor)
		}
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, address, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+tokens[0])
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var restPage struct {
			Items []struct {
				Path        string `json:"path"`
				ContentType string `json:"contentType"`
				SizeBytes   int64  `json:"sizeBytes"`
			} `json:"items"`
			NextCursor *string `json:"nextCursor"`
		}
		decodeErr := json.NewDecoder(response.Body).Decode(&restPage)
		closeErr := response.Body.Close()
		if response.StatusCode != http.StatusOK || decodeErr != nil || closeErr != nil {
			t.Fatalf("REST recovery status=%d decode=%v close=%v", response.StatusCode, decodeErr, closeErr)
		}
		pages++
		for _, item := range restPage.Items {
			if item.Path == refs["path"] {
				found = true
				if item.ContentType != "text/plain; x="+strings.Repeat("a", 100000) || item.SizeBytes != 1 {
					t.Fatalf("REST recovery metadata: %+v", item)
				}
			}
		}
		if found || restPage.NextCursor == nil {
			break
		}
		if pages >= 10 {
			t.Fatal("REST recovery did not converge")
		}
		restCursor = restPage.NextCursor
	}
	if !found || pages < 2 {
		t.Fatal("REST recovery did not return the attachment")
	}
	boundaryPath := strings.Repeat(strings.Repeat("😀", 50)+"/", 20) + "😀😀😀😀"
	boundedContentType := "text/plain; x=" + strings.Repeat("a", 4000)
	if _, _, err := attachments.Put(t.Context(), principal, projectID, parent.ID, boundaryPath, boundedContentType, strings.NewReader("x")); err != nil {
		t.Fatalf("boundary path: %v", err)
	}
	boundaryPage := obj(call(alice, "task_attachment_list", map[string]any{"projectId": projectID, "taskId": parent.ID, "cursor": refs["nextCursor"]}, false)["data"])
	boundaryItems := boundaryPage["items"].([]any)
	if len(boundaryItems) != 1 || obj(boundaryItems[0])["path"] != boundaryPath || obj(boundaryItems[0])["contentType"] != boundedContentType {
		t.Fatalf("boundary page: %+v", boundaryPage)
	}

}
