package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
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

type invitationLog struct {
	mu sync.Mutex
	bytes.Buffer
}

func (l *invitationLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.Buffer.Write(p)
}
func (l *invitationLog) text() string { l.mu.Lock(); defer l.mu.Unlock(); return l.Buffer.String() }

// lostAcceptanceTransport waits for the server response, then loses the receipt.
// This models a transport failure after a possibly committed operation.
type lostAcceptanceTransport struct {
	token string
	calls atomic.Int32
}

func (tr *lostAcceptanceTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+tr.token)
	var input struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if req.Body != nil {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		_ = json.Unmarshal(body, &input)
	}
	if input.Method != "tools/call" || input.Params.Name != "invitation_accept" {
		return http.DefaultTransport.RoundTrip(r)
	}
	tr.calls.Add(1)
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	_, readErr := io.Copy(io.Discard, resp.Body)
	closeErr := resp.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return nil, errors.New("acceptance response lost")
}

func callInvitationTool(t *testing.T, client *sdk.ClientSession, name string, args map[string]any, wantError bool) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s call: %v", name, err)
	}
	if result.IsError != wantError {
		t.Fatalf("%s: unexpected error state %v", name, result.IsError)
	}
	encoded, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if wantError {
		if link, ok := args["link"].(string); ok {
			parts := strings.SplitN(link, "#", 2)
			if strings.Contains(string(encoded), link) || (len(parts) == 2 && parts[1] != "" && strings.Contains(string(encoded), parts[1])) {
				t.Fatal("invitation secret appeared in an error response")
			}
		}
	}
	var envelope map[string]any
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	key := "data"
	if wantError {
		key = "error"
	}
	value, ok := envelope[key].(map[string]any)
	if !ok {
		t.Fatalf("%s returned no %s object", name, key)
	}
	return value
}

func TestMCPInvitationWorkflow(t *testing.T) {
	database := projectTestStore(t)
	files := attachmentTestFiles(t)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL, config.UniAuthURL = origin, callback, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret = gateway.AppID, gateway.AppSecret
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logs := &invitationLog{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	handler, err := newTestHandler(Dependencies{Store: database, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	app := handler.(*sessionApplication)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	t.Cleanup(server.Close)
	identityClient, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.New(database, identityClient, callback)
	clients := make([]*sdk.ClientSession, 2)
	principals := make([]model.Principal, 2)
	tokens := make([]string, 2)
	for i, name := range []string{"alice", "bob"} {
		browser := testauth.Browser(t)
		testauth.Login(t, browser, origin, name)
		token := testauth.CreatePAT(t, browser, origin)
		tokens[i] = token
		principals[i], err = identity.Authenticate(t.Context(), model.PATCredential, token)
		if err != nil {
			t.Fatal(err)
		}
		clients[i] = mcpPATClient(t, server.URL, token)
	}
	admin, member := principals[0], principals[1]
	teams := teamservice.NewTeams(database)
	team, err := teams.Create(t.Context(), admin, coreteam.CreateTeam{Name: "Invitation Team", ExpectedUserID: admin.UserID})
	if err != nil {
		t.Fatal(err)
	}
	otherTeam, err := teams.Create(t.Context(), admin, coreteam.CreateTeam{Name: "Other Team", ExpectedUserID: admin.UserID})
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"team": team.ID, "confirm": true}
	created := make([]map[string]any, 0, 3)
	links := make([]string, 0, 3)
	for range 3 {
		item := callInvitationTool(t, clients[0], "team_invitation_create", args, false)
		link, ok := item["link"].(string)
		if !ok || !strings.HasPrefix(link, origin+"/team-invitations#dnteam_") {
			t.Fatal("invalid created Team invitation link")
		}
		created = append(created, item)
		links = append(links, link)
	}
	callInvitationTool(t, clients[0], "team_invitation_create", map[string]any{"team": team.ID}, true)
	seen := map[string]bool{}
	var cursor any
	for range 3 {
		pageArgs := map[string]any{"team": team.ID, "limit": 1}
		if cursor != nil {
			pageArgs["cursor"] = cursor
		}
		page := callInvitationTool(t, clients[0], "team_invitation_list", pageArgs, false)
		encoded, _ := json.Marshal(page)
		for _, link := range links {
			if strings.Contains(string(encoded), link) || strings.Contains(string(encoded), strings.Split(link, "#")[1]) {
				t.Fatal("invitation list exposed secret")
			}
		}
		items, ok := page["items"].([]any)
		if !ok || len(items) != 1 {
			t.Fatalf("expected one item per page, got %d", len(items))
		}
		item, ok := items[0].(map[string]any)
		if !ok {
			t.Fatal("invalid page item")
		}
		id, _ := item["id"].(string)
		if id == "" || seen[id] {
			t.Fatal("missing or repeated invitation")
		}
		seen[id] = true
		if _, ok := item["link"]; ok {
			t.Fatal("list returned link")
		}
		if _, ok := item["secret"]; ok {
			t.Fatal("list returned secret")
		}
		cursor = page["nextCursor"]
		if len(seen) == 1 {
			if cursor == nil {
				t.Fatal("missing next cursor")
			}
			callInvitationTool(t, clients[0], "team_invitation_list", map[string]any{"team": otherTeam.ID, "limit": 1, "cursor": cursor}, true)
		}
	}
	if cursor != nil {
		t.Fatal("unexpected final cursor")
	}
	for _, item := range created {
		if !seen[item["id"].(string)] {
			t.Fatal("page omitted invitation")
		}
	}
	for _, bad := range []string{strings.Replace(links[0], origin, "https://other.invalid", 1), links[0] + "?query", " " + links[0], strings.Replace(links[0], "/team-invitations", "/x/../team-invitations", 1)} {
		callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": bad}, true)
	}
	preview := callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[0]}, false)
	if preview["scope"] != "team" || preview["membership"] != nil {
		t.Fatal("Team preview did not describe the nonmember")
	}
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0]}, true)
	accepted := callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0], "confirm": true}, false)
	if accepted["scope"] != "team" || accepted["joined"] != true || accepted["consumed"] != true {
		t.Fatal("Team acceptance did not report joining and consumption")
	}
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0], "confirm": true}, true)
	var count int
	if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, member.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("Team membership count: %d, %v", count, err)
	}
	existing := callInvitationTool(t, clients[0], "invitation_accept", map[string]any{"link": links[1], "confirm": true}, false)
	if existing["joined"] != false || existing["consumed"] != false {
		t.Fatal("existing Team member consumed invitation")
	}
	revokeArgs := map[string]any{"team": team.ID, "invitationId": created[1]["id"], "confirm": true}
	if callInvitationTool(t, clients[0], "team_invitation_revoke", revokeArgs, false)["changed"] != true {
		t.Fatal("revoke did not change invitation")
	}
	if callInvitationTool(t, clients[0], "team_invitation_revoke", revokeArgs, false)["changed"] != false {
		t.Fatal("repeat revoke was not unchanged")
	}
	callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[1]}, true)
	if _, err := database.Pool.Exec(t.Context(), `UPDATE team_invitations SET created_at=now()-interval '2 seconds', expires_at=now()-interval '1 second' WHERE id=$1`, created[2]["id"]); err != nil {
		t.Fatal(err)
	}
	callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[2]}, true)

	// Force a page larger than the encoded response budget. The cursor must
	// continue after the last returned item rather than the last database row read.
	if _, err := database.Pool.Exec(t.Context(), `INSERT INTO team_invitations(id, team_id, created_by, token_hash, created_at, expires_at) SELECT gen_random_uuid(), $1, $2, sha256(('page-' || n::text)::bytea), now(), now()+interval '1 day' FROM generate_series(1,100) n`, team.ID, admin.UserID); err != nil {
		t.Fatal(err)
	}
	seen = map[string]bool{}
	cursor = nil
	pages := 0
	for {
		pageArgs := map[string]any{"team": team.ID, "limit": 100}
		if cursor != nil {
			pageArgs["cursor"] = cursor
		}
		page := callInvitationTool(t, clients[0], "team_invitation_list", pageArgs, false)
		encoded, _ := json.Marshal(page)
		if len(encoded) > 16<<10 {
			t.Fatal("invitation page exceeds output budget")
		}
		items, ok := page["items"].([]any)
		if !ok || len(items) == 0 {
			t.Fatal("empty invitation page")
		}
		for _, value := range items {
			item := value.(map[string]any)
			id := item["id"].(string)
			if seen[id] {
				t.Fatal("repeated invitation across byte-budget pages")
			}
			seen[id] = true
		}
		pages++
		cursor = page["nextCursor"]
		if cursor == nil {
			break
		}
		if pages > 100 {
			t.Fatal("pagination did not terminate")
		}
	}
	if len(seen) != 100 || pages < 2 {
		t.Fatalf("byte-budget pagination returned %d items over %d pages", len(seen), pages)
	}

	project, err := projectservice.NewProjects(database).Create(t.Context(), admin, coreproject.CreateProject{Name: "Invite Project", RepoURL: "https://example.test/owner/repo.git", ExpectedUserID: admin.UserID})
	if err != nil {
		t.Fatal(err)
	}
	invite, err := projectservice.NewMemberships(database).CreateInvitation(t.Context(), admin, project.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	projectLink := origin + "/invitations#" + invite.Secret
	ownerReceipt := callInvitationTool(t, clients[0], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	if ownerReceipt["joined"] != false || ownerReceipt["consumed"] != false {
		t.Fatal("existing Project member consumed invitation")
	}
	projectPreview := callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": projectLink}, false)
	if projectPreview["scope"] != "project" || projectPreview["projectId"] != project.ID {
		t.Fatal("Project preview missing project identity")
	}
	projectAccepted := callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	if projectAccepted["scope"] != "project" || projectAccepted["projectId"] != project.ID || projectAccepted["joined"] != true || projectAccepted["consumed"] != true {
		t.Fatal("Project acceptance missing receipt")
	}
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, true)
	if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("Project grant count: %d, %v", count, err)
	}
	// Drop a real HTTP acceptance response after the server finishes writing it.
	// The database records the resulting membership and consumption, while the
	// client cannot claim the missing receipt or repeat the mutation.
	lostTeam, err := teams.Create(t.Context(), admin, coreteam.CreateTeam{Name: "Lost receipt Team", ExpectedUserID: admin.UserID})
	if err != nil {
		t.Fatal(err)
	}
	lostInvitation, err := teams.CreateInvitation(t.Context(), admin, lostTeam.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	lostLink := origin + "/team-invitations#" + lostInvitation.Secret
	transport := &lostAcceptanceTransport{token: tokens[1]}
	sdkClient := sdk.NewClient(&sdk.Implementation{Name: "lost-receipt-test", Version: "1"}, nil)
	connectCtx, connectCancel := context.WithTimeout(t.Context(), 5*time.Second)
	lostClient, err := sdkClient.Connect(connectCtx, &sdk.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	connectCancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lostClient.Close() })
	callCtx, callCancel := context.WithTimeout(t.Context(), 5*time.Second)
	_, callErr := lostClient.CallTool(callCtx, &sdk.CallToolParams{Name: "invitation_accept", Arguments: map[string]any{"link": lostLink, "confirm": true}})
	callCancel()
	if callErr == nil || transport.calls.Load() != 1 {
		t.Fatalf("lost receipt: error=%v calls=%d", callErr, transport.calls.Load())
	}
	if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2`, lostTeam.ID, member.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("lost receipt membership: %d, %v", count, err)
	}
	var consumedBy *string
	if err := database.Pool.QueryRow(t.Context(), `SELECT consumed_by::text FROM team_invitations WHERE id=$1`, lostInvitation.Invitation.ID).Scan(&consumedBy); err != nil || consumedBy == nil || *consumedBy != member.UserID {
		t.Fatalf("lost receipt consumption: %v", err)
	}
	links = append(links, lostLink)
	for _, link := range append(links, projectLink) {
		if strings.Contains(logs.text(), link) || strings.Contains(logs.text(), strings.Split(link, "#")[1]) {
			t.Fatal("invitation secret appeared in logs")
		}
	}
}
