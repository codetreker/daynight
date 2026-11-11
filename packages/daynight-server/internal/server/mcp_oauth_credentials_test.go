package server

import (
	"bytes"
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
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestOAuthAccessBusinessAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	f := newOAuthHTTPFixture(t)
	f.Origin = "https://daynight.test"
	const grantID = "e5555555-5555-4555-8555-555555555555"
	const accessID = "f6666666-6666-4666-8666-666666666666"
	const replacementID = "a7777777-7777-4777-8777-777777777777"
	token := httpTestToken(model.OAuthCredential)
	replacement := "dnmcp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
	p := model.Principal{Kind: model.OAuthCredential, UserID: f.Principal.UserID, CredentialID: accessID}
	replacementPrincipal := p
	replacementPrincipal.CredentialID = replacementID
	resource := f.Origin + "/mcp"
	var authentications atomic.Int32
	configureAccess := func(refused bool) {
		f.Store.WriteCredentialFamilyCall = func(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
			plan := newHTTPCallPlan(t, map[string]int{"authenticate": 1})
			dao := &oauthHTTPFamilyDAO{t: t, plan: plan, authenticate: func(hash []byte, actualResource, scope string, now time.Time) (store.OAuthAccessIdentity, error) {
				authentications.Add(1)
				if actualResource != resource || scope != "daynight:mcp" || now.IsZero() || now.Location() != time.UTC {
					unexpectedHTTPCall(t, "MCP OAuth credential scope")
				}
				if !bytes.Equal(hash, secret.Hash(token)) && !bytes.Equal(hash, secret.Hash(replacement)) {
					unexpectedHTTPCall(t, "MCP OAuth token hash")
				}
				if refused {
					return store.OAuthAccessIdentity{}, model.ErrNotFound
				}
				actor := p
				if bytes.Equal(hash, secret.Hash(replacement)) {
					actor = replacementPrincipal
				}
				return store.OAuthAccessIdentity{Principal: actor, GrantID: grantID}, nil
			}}
			e := fn(oauthHTTPFamilyScope{families: dao})
			return oauthHTTPCompletion(e), e
		}
	}
	configureAccess(false)
	config := configuredTestConfig()
	config.Server.PublicOrigin = f.Origin
	config.UniAuth.CallbackURL = f.Origin + "/api/v1/auth/callback"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	production, err := newTestHandler(Dependencies{Store: f.Store, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer production.(Handler).Shutdown(context.Background())
	productionServer := httptest.NewServer(httpx.RequestLogging(logger, production))
	defer productionServer.Close()
	productionClient := mcpPATClient(t, productionServer.URL, token)
	if _, err = productionClient.ListTools(ctx, nil); err != nil {
		t.Fatalf("production MCP OAuth: %v", err)
	}
	replacementClient := mcpPATClient(t, productionServer.URL, replacement)
	if _, err = replacementClient.ListTools(ctx, nil); err != nil {
		t.Fatalf("production MCP replacement OAuth: %v", err)
	}
	const personalTeam = "b8888888-8888-4888-8888-888888888888"
	const privateTeam = "c9999999-9999-4999-8999-999999999999"
	f.PersonalTeamID = personalTeam
	for _, tc := range []struct {
		team   string
		denied bool
	}{{"personal", false}, {privateTeam, true}} {
		plan := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "team": 1})
		snapshot := newHTTPTestSnapshot(t)
		snapshot.Teams = &oauthMCPTeamReader{t: t, plan: plan, actor: p.UserID, selector: tc.team, id: personalTeam, denied: tc.denied}
		f.Store.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
			plan.Called("snapshot")
			return fn(snapshot)
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
	}
	const projectID = "d1111111-1111-4111-8111-111111111111"
	const taskID = "e2222222-2222-4222-8222-222222222222"
	for _, path := range []string{"/api/v1/projects", "/api/v1/projects/" + projectID + "/tasks/" + taskID + "/worker-claim"} {
		r := httptest.NewRequest(http.MethodPost, path, nil)
		if path == "/api/v1/projects" {
			r.Method = http.MethodGet
		}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		production.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("OAuth on REST %s: %d", path, w.Code)
		}
	}
	threads := taskservice.NewTaskThreads(f.Store, nil)
	bot := model.Bot{ID: "a4444444-4444-4444-8444-444444444444", OwnerUserID: p.UserID, Version: 1}
	deletions := botservice.NewDeletions(f.Store, nil, sessioncore.NewEngine(nil))
	deletion := store.DeleteBot{Version: bot.Version, DeletionID: "c6666666-6666-4666-8666-666666666666"}
	configureAccess(true)
	oauthMCPThreadRefused(t, f, p, projectID, taskID)
	oauthMCPDeleteRefused(t, f, p)
	var threadError, botError error
	done := make(chan struct{}, 2)
	go func() {
		_, threadError = threads.Post(ctx, p, projectID, taskID, taskservice.CreateThreadMessage{Body: "credential refusal"})
		done <- struct{}{}
	}()
	go func() { _, botError = deletions.DeleteBot(ctx, p, bot.ID, deletion); done <- struct{}{} }()
	for range 2 {
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if threadError == nil || botError == nil {
		t.Fatal("concurrent business calls accepted refused credentials")
	}
	if _, err = productionClient.ListTools(ctx, nil); err == nil {
		t.Fatal("production MCP accepted refused access")
	}
	if _, err = replacementClient.ListTools(ctx, nil); err == nil {
		t.Fatal("production MCP accepted refused replacement access")
	}
	if authentications.Load() == 0 {
		t.Fatal("MCP authentication did not execute")
	}
}

type oauthMCPTeamReader struct {
	store.TeamReader
	t                   *testing.T
	plan                *httpCallPlan
	actor, selector, id string
	denied              bool
}

func (d *oauthMCPTeamReader) Team(_ context.Context, user, id string) (model.Team, error) {
	d.plan.Called("team")
	expected := d.selector
	if expected == "personal" {
		expected = d.id
	}
	if user != d.actor || id != expected {
		unexpectedHTTPCall(d.t, "OAuth Team read arguments")
	}
	if d.denied {
		return model.Team{}, model.ErrNotFound
	}
	return model.Team{TeamRef: model.TeamRef{ID: d.id, Kind: "personal"}, Version: 1, Membership: model.TeamMember{TeamID: d.id, UserID: user, Role: model.ProjectAdmin, Version: 1}}, nil
}

type oauthMCPThreadScope struct {
	store.ThreadScope
	dao *oauthMCPThreadRefusalDAO
}

func (s oauthMCPThreadScope) TaskDAO() store.ThreadTaskDAO             { return s.dao }
func (s oauthMCPThreadScope) CredentialDAO() store.ThreadCredentialDAO { return s.dao }

type oauthMCPThreadRefusalDAO struct {
	store.ThreadTaskDAO
	store.ThreadCredentialDAO
	t             *testing.T
	plan          *httpCallPlan
	principal     model.Principal
	project, task string
}

func (d *oauthMCPThreadRefusalDAO) LockTaskPresence(_ context.Context, project, task string) (store.TaskPresence, error) {
	d.plan.Called("task")
	if project != d.project || task != d.task {
		unexpectedHTTPCall(d.t, "OAuth Thread Task scope")
	}
	return store.TaskPresence{Found: true}, nil
}
func (d *oauthMCPThreadRefusalDAO) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.plan.Called("credential")
	if p != d.principal {
		unexpectedHTTPCall(d.t, "OAuth Thread principal")
	}
	return store.ThreadCredential{}, model.ErrNotFound
}
func oauthMCPThreadRefused(t *testing.T, f *oauthHTTPFixture, p model.Principal, project, task string) {
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "task": 1, "credential": 1})
	dao := &oauthMCPThreadRefusalDAO{t: t, plan: plan, principal: p, project: project, task: task}
	f.Store.WriteThreadCall = func(ctx context.Context, fn func(store.ThreadScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthMCPThreadScope{dao: dao})
		return oauthHTTPCompletion(e), e
	}
}

type oauthMCPDeleteScope struct {
	store.SessionScope
	dao *oauthMCPDeleteRefusalDAO
}

func (s oauthMCPDeleteScope) SessionDAO() store.SessionDAO { return s.dao }

type oauthMCPDeleteRefusalDAO struct {
	store.SessionDAO
	t         *testing.T
	plan      *httpCallPlan
	principal model.Principal
}

func (d *oauthMCPDeleteRefusalDAO) LockCredential(_ context.Context, p model.Principal, now time.Time) error {
	d.plan.Called("credential")
	if p != d.principal || now.IsZero() {
		unexpectedHTTPCall(d.t, "OAuth deletion credential")
	}
	return model.ErrNotFound
}
func oauthMCPDeleteRefused(t *testing.T, f *oauthHTTPFixture, p model.Principal) {
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "credential": 1})
	dao := &oauthMCPDeleteRefusalDAO{t: t, plan: plan, principal: p}
	f.Store.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthMCPDeleteScope{dao: dao})
		return oauthHTTPCompletion(e), e
	}
}
