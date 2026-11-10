package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestOAuthAccessBusinessAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const origin = "https://daynight.test"
	const grantID = "e5555555-5555-4555-8555-555555555555"
	const accessID = "f6666666-6666-4666-8666-666666666666"
	const replacementID = "a7777777-7777-4777-8777-777777777777"
	token := httpTestToken(model.OAuthCredential)
	replacement := "dnmcp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
	p := model.Principal{Kind: model.OAuthCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: accessID}
	replacementPrincipal := p
	replacementPrincipal.CredentialID = replacementID
	access := &oauthMCPAccessOperations{t: t, resource: origin + "/mcp", identities: map[string]store.OAuthAccessIdentity{
		token: {Principal: p, GrantID: grantID}, replacement: {Principal: replacementPrincipal, GrantID: grantID},
	}}
	teams := &oauthMCPTeamOperations{operationRejectedTeams: operationRejectedTeams{t: t}}
	config := configuredTestConfig()
	config.PublicOrigin = origin
	config.UniAuthCallbackURL = origin + "/api/v1/auth/callback"
	var identity *mcpOperationIdentity
	productionServer, production := newMCPOperationServerWithConfig(t, nil, attachmentTestFiles(t), config, func(app *service.App) {
		identity = app.Identity.(*mcpOperationIdentity)
		app.OAuth, app.Teams = access, teams
	})
	productionClient := mcpPATClient(t, productionServer.URL, token)
	list, err := productionClient.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("production MCP OAuth: %v", err)
	}
	assertMCPProductionTools(t, list.Tools)
	const personalTeam = "b8888888-8888-4888-8888-888888888888"
	const privateTeam = "c9999999-9999-4999-8999-999999999999"
	personalCalls := 0
	identity.PersonalTeamIDCall = func(ctx context.Context, actual model.Principal) (string, error) {
		personalCalls++
		if personalCalls != 1 || actual != p {
			t.Errorf("OAuth personal Team resolution: count=%d actor=%+v", personalCalls, actual)
		}
		return personalTeam, nil
	}
	t.Cleanup(func() {
		if personalCalls != 1 {
			t.Errorf("OAuth personal Team resolution count=%d, want1", personalCalls)
		}
	})
	for _, tc := range []struct {
		team   string
		denied bool
	}{{"personal", false}, {privateTeam, true}} {
		expectedID := tc.team
		if expectedID == "personal" {
			expectedID = personalTeam
		}
		called := 0
		teams.GetCall = func(ctx context.Context, actual model.Principal, id string) (model.Team, error) {
			called++
			if called != 1 || actual != p || id != expectedID {
				t.Errorf("OAuth Team read args/count: %d %+v %s", called, actual, id)
			}
			if tc.denied {
				return model.Team{}, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: model.ErrNotFound}
			}
			return model.Team{TeamRef: model.TeamRef{ID: personalTeam, Kind: "personal"}, Version: 1, Membership: model.TeamMember{TeamID: personalTeam, UserID: p.UserID, Role: model.ProjectAdmin, Version: 1}}, nil
		}
		result, e := productionClient.CallTool(ctx, &sdk.CallToolParams{Name: "team_show", Arguments: map[string]any{"team": tc.team}})
		if e != nil || result.IsError != tc.denied {
			t.Fatalf("OAuth Team read %s: %#v %v", tc.team, result, e)
		}
		raw, e := json.Marshal(result.StructuredContent)
		if e != nil {
			t.Fatal(e)
		}
		var envelope struct {
			Data struct {
				Membership struct {
					UserID string `json:"userId"`
				}
			}
			Error struct{ Code string }
		}
		if json.Unmarshal(raw, &envelope) != nil || (!tc.denied && envelope.Data.Membership.UserID != p.UserID) || (tc.denied && envelope.Error.Code != "not_found") {
			t.Fatalf("OAuth Team read: %s", raw)
		}
		if called != 1 {
			t.Errorf("OAuth Team read calls=%d, want1", called)
		}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := mcphttp.New(identity, origin, nil, logger, mcpOperationOAuth{t: t, operations: access})
	if err != nil {
		t.Fatal(err)
	}
	if err = entry.RegisterTool(&sdk.Tool{Name: "actor", InputSchema: map[string]any{"type": "object"}, OutputSchema: map[string]any{"type": "object"}}, mcphttp.BudgetControl, func(ctx context.Context, actor mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
		mcpOperationContext(t, ctx, actor.Principal)
		return mcphttp.ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "access": actor.Principal.CredentialID, "authority": actor.AuthorityRef.ID, "kind": actor.AuthorityRef.Kind}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	marked := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		marker := &mcpStepMarker{}
		entry.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mcpStepMarkerKey{}, marker)))
		if r.Header.Get("Authorization") != "" {
			marker.mu.Lock()
			calls := marker.authCalls
			marker.mu.Unlock()
			if calls != 1 {
				t.Errorf("OAuth actor request authentication calls=%d, want1", calls)
			}
		}
	})
	httpServer := httptest.NewServer(httpx.RequestLogging(logger, marked))
	t.Cleanup(func() {
		entry.BeginShutdown()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Config.Shutdown(shutdown); err != nil {
			t.Errorf("OAuth actor HTTP shutdown: %v", err)
			if err := httpServer.Config.Close(); err != nil {
				t.Error(err)
			}
		}
		drain, drainCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer drainCancel()
		if err := entry.Shutdown(drain); err != nil {
			t.Errorf("OAuth actor entry shutdown: %v", err)
		}
		httpServer.Close()
	})
	client := sdk.NewClient(&sdk.Implementation{Name: "oauth-test", Version: "1"}, nil)
	connect := func(raw string) *sdk.ClientSession {
		t.Helper()
		s, e := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: httpServer.URL, HTTPClient: &http.Client{Transport: mcpPATTransport{token: raw}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
		if e != nil {
			t.Fatal(e)
		}
		return s
	}
	session := connect(token)
	defer session.Close()
	replacementSession := connect(replacement)
	defer replacementSession.Close()
	for _, tc := range []struct {
		session *sdk.ClientSession
		access  string
	}{{session, accessID}, {replacementSession, replacementID}} {
		result, e := tc.session.CallTool(ctx, &sdk.CallToolParams{Name: "actor", Arguments: map[string]any{}})
		if e != nil || result.IsError {
			t.Fatalf("MCP actor: %v", e)
		}
		raw, e := json.Marshal(result.StructuredContent)
		if e != nil {
			t.Fatal(e)
		}
		var envelope struct {
			Data struct{ User, Access, Authority, Kind string }
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope.Data.User != p.UserID || envelope.Data.Access != tc.access || envelope.Data.Authority != grantID || envelope.Data.Kind != "oauth" {
			t.Fatalf("MCP actor: %s", raw)
		}
	}
	const projectID = "d1111111-1111-4111-8111-111111111111"
	const taskID = "e2222222-2222-4222-8222-222222222222"
	identity.setCredential(model.PATCredential, token, model.Principal{}, model.Unauthenticated(nil))
	rest := markMCPOperationRequests(t, production)
	beforeREST := access.calls.Load()
	for _, path := range []string{"/api/v1/projects", "/api/v1/projects/" + projectID + "/tasks/" + taskID + "/worker-claim"} {
		r := httptest.NewRequest(http.MethodPost, path, nil)
		if path == "/api/v1/projects" {
			r.Method = http.MethodGet
		}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		rest.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("OAuth on REST %s: %d", path, w.Code)
		}
	}
	if access.calls.Load() != beforeREST {
		t.Error("REST OAuth rejection invoked MCP authentication")
	}
	if calls := identity.credentialCalls(token); calls != 2 {
		t.Errorf("REST credential rejection calls=%d, want2", calls)
	}
	access.refused.Store(true)
	if _, err = productionClient.ListTools(ctx, nil); err == nil {
		t.Fatal("production MCP accepted revoked access")
	}
	if _, err = session.CallTool(ctx, &sdk.CallToolParams{Name: "actor", Arguments: map[string]any{}}); err == nil {
		t.Fatal("revoked MCP accepted")
	}
	if access.calls.Load() == 0 {
		t.Fatal("MCP authentication did not execute")
	}
}

type oauthMCPAccessOperations struct {
	t          *testing.T
	resource   string
	identities map[string]store.OAuthAccessIdentity
	calls      atomic.Int32
	refused    atomic.Bool
}

func (o *oauthMCPAccessOperations) AuthenticateAccess(ctx context.Context, token, resource string) (store.OAuthAccessIdentity, error) {
	o.calls.Add(1)
	result, ok := o.identities[token]
	if !ok || resource != o.resource || ctx.Err() != nil {
		o.t.Errorf("OAuth authentication changed rawtoken/resource/context: declared=%t resource=%s err=%v", ok, resource, ctx.Err())
		return store.OAuthAccessIdentity{}, model.Unauthenticated(nil)
	}
	if o.refused.Load() {
		return store.OAuthAccessIdentity{}, model.Unauthenticated(model.ErrNotFound)
	}
	return result, nil
}

type oauthMCPTeamOperations struct {
	operationRejectedTeams
	GetCall func(context.Context, model.Principal, string) (model.Team, error)
}

func (o *oauthMCPTeamOperations) Get(ctx context.Context, p model.Principal, id string) (model.Team, error) {
	mcpOperationContext(o.t, ctx, p)
	if o.GetCall == nil {
		return o.operationRejectedTeams.Get(ctx, p, id)
	}
	return o.GetCall(ctx, p, id)
}
