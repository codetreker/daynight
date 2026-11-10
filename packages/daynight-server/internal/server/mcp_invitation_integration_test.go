package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
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
	admin := defaultHTTPPrincipal()
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	org := newMCPOrgFixture(t)
	logs := &invitationLog{}
	server, _ := newMCPOperationServer(t, map[string]model.Principal{tokens[0]: admin, tokens[1]: member}, attachmentTestFiles(t), func(app *service.App) { org.configure(app) }, logs)
	origin := server.URL
	clients := []*sdk.ClientSession{mcpPATClient(t, origin, tokens[0]), mcpPATClient(t, origin, tokens[1])}
	team := mcpOrgTeam(t, "e5555555-5555-4555-8555-555555555555", "Invitation Team", admin.UserID)
	otherTeam := mcpOrgTeam(t, "f6666666-6666-4666-8666-666666666666", "Other Team", admin.UserID)
	args := map[string]any{"team": team.ID, "confirm": true}
	created := make([]map[string]any, 0, 3)
	links := make([]string, 0, 3)
	invitations := make([]model.TeamInvitation, 0, 3)
	for range 3 {
		captured := mcpOrgMintInvitation(t, org, admin, team)
		item := callInvitationTool(t, clients[0], "team_invitation_create", args, false)
		link, ok := item["link"].(string)
		if !ok || !strings.HasPrefix(link, origin+"/team-invitations#dnteam_") {
			t.Fatal("invalid created Team invitation link")
		}
		token := strings.Split(link, "#")[1]
		projectHTTPCheck(t, captured.TokenHash, secret.Hash(token))
		projectHTTPCheck(t, item["id"], captured.ID)
		created = append(created, item)
		links = append(links, link)
		invitations = append(invitations, model.TeamInvitation{ID: captured.ID, TeamID: team.ID, CreatedBy: admin.UserID, TokenHash: secret.Hash(token), CreatedAt: captured.CreatedAt, ExpiresAt: captured.CreatedAt.Add(7 * 24 * time.Hour)})
	}
	callInvitationTool(t, clients[0], "team_invitation_create", map[string]any{"team": team.ID}, true)
	seen := map[string]bool{}
	var cursor any
	for i := range 3 {
		wantPage := model.PageRequest{Limit: 1}
		if i > 0 {
			current := cursor.(string)
			wantPage.Cursor = &current
		}
		row := invitations[i]
		result := teamcore.InvitationPage{Items: []model.TeamInvitation{row}}
		if i < 2 {
			next := fmt.Sprintf("invitation-page-%d", i+2)
			result.NextCursor = &next
		}
		mcpOrgInvitationPage(t, org, admin, team.ID, wantPage, result, nil)
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
		projectHTTPCheck(t, id, row.ID)
		seen[id] = true
		if _, ok := item["link"]; ok {
			t.Fatal("list returned link")
		}
		if _, ok := item["secret"]; ok {
			t.Fatal("list returned secret")
		}
		cursor = page["nextCursor"]
		if i == 0 {
			if cursor == nil {
				t.Fatal("missing next cursor")
			}
			current := cursor.(string)
			mcpOrgInvitationPage(t, org, admin, otherTeam.ID, model.PageRequest{Limit: 1, Cursor: &current}, teamcore.InvitationPage{}, &model.Fault{Code: "invalid_input", Message: "Invalid cursor."})
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
	token := strings.Split(links[0], "#")[1]
	mcpOrgInspectTeam(t, org, member, team.TeamRef, token, nil)
	preview := callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[0]}, false)
	if preview["scope"] != "team" || preview["membership"] != nil {
		t.Fatal("Team preview did not describe the nonmember")
	}
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0]}, true)
	joinedMember := model.TeamMember{TeamID: team.ID, UserID: member.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: team.CreatedAt, UpdatedAt: team.UpdatedAt}
	mcpOrgAcceptTeam(t, org, member, team.TeamRef, token, joinedMember, false)
	accepted := callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0], "confirm": true}, false)
	if accepted["scope"] != "team" || accepted["joined"] != true || accepted["consumed"] != true {
		t.Fatal("Team acceptance did not report joining and consumption")
	}
	consumedAt := time.Now().UTC()
	mcpOrgRejectTeamAcceptance(t, org, member, token)
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0], "confirm": true}, true)
	token = strings.Split(links[1], "#")[1]
	mcpOrgAcceptTeam(t, org, admin, team.TeamRef, token, team.Membership, true)
	existing := callInvitationTool(t, clients[0], "invitation_accept", map[string]any{"link": links[1], "confirm": true}, false)
	if existing["joined"] != false || existing["consumed"] != false {
		t.Fatal("existing Team member consumed invitation")
	}
	revokeArgs := map[string]any{"team": team.ID, "invitationId": created[1]["id"], "confirm": true}
	mcpOrgRevokeInvitation(t, org, admin, team, invitations[1].ID, true)
	if callInvitationTool(t, clients[0], "team_invitation_revoke", revokeArgs, false)["changed"] != true {
		t.Fatal("revoke did not change invitation")
	}
	mcpOrgRevokeInvitation(t, org, admin, team, invitations[1].ID, false)
	if callInvitationTool(t, clients[0], "team_invitation_revoke", revokeArgs, false)["changed"] != false {
		t.Fatal("repeat revoke was not unchanged")
	}
	mcpOrgRejectTeamInspection(t, org, member, token)
	callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[1]}, true)
	mcpOrgRejectTeamInspection(t, org, member, strings.Split(links[2], "#")[1])
	callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[2]}, true)

	rows := make([]model.TeamInvitation, 100)
	for i := range rows {
		rows[i] = model.TeamInvitation{ID: fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1), TeamID: team.ID, CreatedBy: admin.UserID, CreatedAt: team.CreatedAt.Add(time.Duration(i) * time.Second), ExpiresAt: consumedAt.Add(24 * time.Hour)}
	}
	mcpOrgInvitationPage(t, org, admin, team.ID, model.PageRequest{Limit: 100}, teamcore.InvitationPage{Items: rows}, nil)
	page := callInvitationTool(t, clients[0], "team_invitation_list", map[string]any{"team": team.ID, "limit": 100}, false)
	items, ok := page["items"].([]any)
	if !ok || len(items) != len(rows) || page["nextCursor"] != nil {
		t.Fatalf("complete invitation page: %+v", page)
	}
	for i, value := range items {
		projectHTTPCheck(t, value.(map[string]any)["id"], rows[i].ID)
	}

	project := projectHTTPRecord("a7777777-7777-4777-8777-777777777777", "Invite Project", "https://example.test/owner/repo.git", "b8888888-8888-4888-8888-888888888888")
	projectToken := "dninvite_" + strings.Repeat("C", 42) + "A"
	projectLink := origin + "/invitations#" + projectToken
	grant := model.ProjectGrant{ProjectID: project.ID, UserID: admin.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt}
	mcpOrgAcceptProject(t, org, admin, project, projectToken, model.ProjectMember{Grant: grant}, true)
	ownerReceipt := callInvitationTool(t, clients[0], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	if ownerReceipt["joined"] != false || ownerReceipt["consumed"] != false {
		t.Fatal("existing Project member consumed invitation")
	}
	mcpOrgInspectProject(t, org, member, project, projectToken)
	projectPreview := callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": projectLink}, false)
	if projectPreview["scope"] != "project" || projectPreview["projectId"] != project.ID {
		t.Fatal("Project preview missing project identity")
	}
	grant.UserID = member.UserID
	grant.Role = model.ProjectMemberRole
	mcpOrgAcceptProject(t, org, member, project, projectToken, model.ProjectMember{Grant: grant}, false)
	projectAccepted := callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	if projectAccepted["scope"] != "project" || projectAccepted["projectId"] != project.ID || projectAccepted["joined"] != true || projectAccepted["consumed"] != true {
		t.Fatal("Project acceptance missing receipt")
	}
	mcpOrgUnavailableProjectInvitation(t, org, member, projectToken)
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, true)
	lostTeam := mcpOrgTeam(t, "d0000000-0000-4000-8000-000000000000", "Lost receipt Team", admin.UserID)
	lostToken := "dnteam_" + strings.Repeat("D", 42) + "A"
	lostLink := origin + "/team-invitations#" + lostToken
	transport := &lostAcceptanceTransport{token: tokens[1]}
	sdkClient := sdk.NewClient(&sdk.Implementation{Name: "lost-receipt-test", Version: "1"}, nil)
	connectCtx, connectCancel := context.WithTimeout(t.Context(), 5*time.Second)
	lostClient, err := sdkClient.Connect(connectCtx, &sdk.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	connectCancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lostClient.Close() })
	lostMember := joinedMember
	lostMember.TeamID = lostTeam.ID
	mcpOrgAcceptTeam(t, org, member, lostTeam.TeamRef, lostToken, lostMember, false)
	callCtx, callCancel := context.WithTimeout(t.Context(), 5*time.Second)
	_, callErr := lostClient.CallTool(callCtx, &sdk.CallToolParams{Name: "invitation_accept", Arguments: map[string]any{"link": lostLink, "confirm": true}})
	callCancel()
	if callErr == nil || transport.calls.Load() != 1 {
		t.Fatalf("lost receipt: error=%v calls=%d", callErr, transport.calls.Load())
	}
	links = append(links, lostLink)
	for _, link := range append(links, projectLink) {
		if strings.Contains(logs.text(), link) || strings.Contains(logs.text(), strings.Split(link, "#")[1]) {
			t.Fatal("invitation secret appeared in logs")
		}
	}
}
