package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
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
	auth := oauthservice.NewAuthenticator(f.Store)
	oauthHTTPExpectAccess(t, f, token, resource, p, grantID, nil)
	identity, err := auth.AuthenticateAccess(ctx, token, resource)
	if err != nil || identity.GrantID != grantID || identity.Principal != p {
		t.Fatalf("authenticate: %+v %v", identity, err)
	}
	oauthHTTPExpectAccess(t, f, token, "https://other.test/mcp", model.Principal{}, "", model.ErrNotFound)
	if _, err = auth.AuthenticateAccess(ctx, token, "https://other.test/mcp"); err == nil {
		t.Fatal("wrong resource accepted")
	}
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
	config.PublicOrigin = f.Origin
	config.UniAuthCallbackURL = f.Origin + "/api/v1/auth/callback"
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
	entry, err := mcphttp.New(identityservice.New(f.Store, nil, ""), f.Origin, nil, logger, auth)
	if err != nil {
		t.Fatal(err)
	}
	if err = entry.RegisterTool(&sdk.Tool{Name: "actor", InputSchema: map[string]any{"type": "object"}, OutputSchema: map[string]any{"type": "object"}}, mcphttp.BudgetControl, func(_ context.Context, actor mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
		return mcphttp.ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "access": actor.Principal.CredentialID, "authority": actor.AuthorityRef.ID, "kind": actor.AuthorityRef.Kind}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(httpx.RequestLogging(logger, entry))
	defer httpServer.Close()
	defer entry.Shutdown(context.Background())
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
	capturePlan := newHTTPCallPlan(t, map[string]int{"capture": 1})
	threads := taskservice.NewTaskThreads(f.Store, oauthMCPThreadCapture{t: t, project: projectID, task: taskID, plan: capturePlan})
	oauthMCPThreadPlan(t, f, p, projectID, taskID, "OAuth author", nil, nil)
	if _, err = threads.Post(ctx, p, projectID, taskID, taskservice.CreateThreadMessage{Body: "OAuth author"}); err != nil {
		t.Fatalf("Thread post: %v", err)
	}
	forged := p
	forged.CredentialID = "f3333333-3333-4333-8333-333333333333"
	oauthMCPThreadPlan(t, f, forged, projectID, taskID, "forged", model.ErrNotFound, nil)
	if _, err = threads.Post(ctx, forged, projectID, taskID, taskservice.CreateThreadMessage{Body: "forged"}); err == nil {
		t.Fatal("forged access ID accepted")
	}
	bot := model.Bot{ID: "a4444444-4444-4444-8444-444444444444", OwnerUserID: p.UserID, WorkerID: "b5555555-5555-4555-8555-555555555555", Name: "OAuth Bot", Version: 1, CreatedAt: f.Now, UpdatedAt: f.Now, ResolvedConfiguration: model.BotConfiguration{WorkerID: "b5555555-5555-4555-8555-555555555555", Cwd: "/workspace", Provider: "codex", Args: []string{}}}
	bots := botservice.New(f.Store)
	input := botcore.CreateBot{ID: bot.ID, Name: bot.Name, ResolvedConfiguration: oauthHTTPCloneBot(bot).ResolvedConfiguration}
	_, fingerprint, normalizeErr := botcore.NormalizeBotRequest(input)
	if normalizeErr != nil {
		t.Fatal(normalizeErr)
	}
	bot.RequestFingerprint = fingerprint
	oauthMCPCreateBot(t, f, p, bot)
	created, createErr := bots.Create(ctx, p, input)
	if createErr != nil || !reflect.DeepEqual(created, bot) {
		t.Fatalf("OAuth Bot create: %+v %v", created, createErr)
	}
	oauthMCPBotRead(t, f, p, bot, nil)
	if _, err = bots.Get(ctx, p, bot.ID); err != nil {
		t.Fatalf("Bot read: %v", err)
	}
	oauthMCPBotRead(t, f, forged, bot, model.ErrNotFound)
	if _, err = bots.Get(ctx, forged, bot.ID); err == nil {
		t.Fatal("forged Bot credential accepted")
	}
	entered, release := make(chan struct{}), make(chan struct{})
	resultCh := make(chan error, 1)
	oauthMCPThreadPlan(t, f, p, projectID, taskID, "expired while waiting", model.ErrNotFound, func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	go func() {
		_, e := threads.Post(ctx, p, projectID, taskID, taskservice.CreateThreadMessage{Body: "expired while waiting"})
		resultCh <- e
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(release)
	select {
	case e := <-resultCh:
		if e == nil {
			t.Fatal("expired Thread write accepted")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	deletions := botservice.NewDeletions(f.Store, nil, sessioncore.NewEngine(nil))
	deletion := store.DeleteBot{Version: bot.Version, DeletionID: "c6666666-6666-4666-8666-666666666666"}
	oauthMCPDeleteRefused(t, f, p, bot, deletion, true)
	if _, err = deletions.DeleteBot(ctx, p, bot.ID, deletion); err == nil {
		t.Fatal("expired Bot deletion accepted")
	}
	configureAccess(true)
	oauthMCPThreadPlan(t, f, p, projectID, taskID, "revoke wait", model.ErrNotFound, nil)
	oauthMCPDeleteRefused(t, f, p, bot, deletion, false)
	var threadError, botError error
	done := make(chan struct{}, 2)
	go func() {
		_, threadError = threads.Post(ctx, p, projectID, taskID, taskservice.CreateThreadMessage{Body: "revoke wait"})
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
		t.Fatal("revoked business waiters accepted")
	}
	if _, err = auth.AuthenticateAccess(ctx, token, resource); err == nil {
		t.Fatal("revoked authentication accepted")
	}
	oauthMCPThreadPlan(t, f, p, projectID, taskID, "revoked", model.ErrNotFound, nil)
	if _, err = threads.Post(ctx, p, projectID, taskID, taskservice.CreateThreadMessage{Body: "revoked"}); err == nil {
		t.Fatal("revoked Thread accepted")
	}
	oauthMCPBotRead(t, f, p, bot, model.ErrNotFound)
	if _, err = bots.Get(ctx, p, bot.ID); err == nil {
		t.Fatal("revoked Bot accepted")
	}
	if _, err = productionClient.ListTools(ctx, nil); err == nil {
		t.Fatal("production MCP accepted revoked access")
	}
	if _, err = session.CallTool(ctx, &sdk.CallToolParams{Name: "actor", Arguments: map[string]any{}}); err == nil {
		t.Fatal("revoked MCP accepted")
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

func (d *oauthMCPTeamReader) TeamBounded(_ context.Context, user, id string, budget int) (model.Team, bool, error) {
	d.plan.Called("team")
	expected := d.selector
	if expected == "personal" {
		expected = d.id
	}
	if user != d.actor || id != expected || budget != httpx.MaxJSONBody {
		unexpectedHTTPCall(d.t, "OAuth Team bounded read arguments")
	}
	if d.denied {
		return model.Team{}, false, model.ErrNotFound
	}
	return model.Team{TeamRef: model.TeamRef{ID: d.id, Kind: "personal"}, Version: 1, Membership: model.TeamMember{TeamID: d.id, UserID: user, Role: model.ProjectAdmin, Version: 1}}, false, nil
}

type oauthMCPThreadScope struct {
	store.ThreadScope
	dao *oauthMCPThreadDAO
}

func (s oauthMCPThreadScope) TaskDAO() store.ThreadTaskDAO             { return s.dao }
func (s oauthMCPThreadScope) CredentialDAO() store.ThreadCredentialDAO { return s.dao }
func (s oauthMCPThreadScope) ProjectDAO() store.ThreadProjectDAO       { return s.dao }
func (s oauthMCPThreadScope) ThreadDAO() store.ThreadDAO               { return s.dao }
func (s oauthMCPThreadScope) CaptureDAO() store.WebhookCaptureDAO      { return nil }

type oauthMCPThreadDAO struct {
	store.ThreadDAO
	t                   *testing.T
	plan                *httpCallPlan
	actor               model.Principal
	project, task, body string
	expiry              time.Time
	credentialError     error
	barrier             func(context.Context) error
	now                 time.Time
}

func (d *oauthMCPThreadDAO) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	d.plan.Called("task")
	if project != d.project || task != d.task {
		unexpectedHTTPCall(d.t, "OAuth Thread Task scope")
	}
	if d.barrier != nil {
		if e := d.barrier(ctx); e != nil {
			return store.TaskPresence{}, e
		}
	}
	return store.TaskPresence{Found: true}, nil
}
func (d *oauthMCPThreadDAO) SourceTask(context.Context, string, string) (model.Task, error) {
	unexpectedHTTPCall(d.t, "OAuth Thread SourceTask")
	return model.Task{}, nil
}
func (d *oauthMCPThreadDAO) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.plan.Called("credential")
	if p != d.actor {
		unexpectedHTTPCall(d.t, "OAuth Thread principal")
	}
	expiry := d.expiry
	return store.ThreadCredential{ExpiresAt: &expiry}, d.credentialError
}
func (d *oauthMCPThreadDAO) CredentialValid(_ context.Context, c store.ThreadCredential) (bool, error) {
	d.plan.Called("valid")
	if c.ExpiresAt == nil || !c.ExpiresAt.Equal(d.expiry) {
		unexpectedHTTPCall(d.t, "OAuth Thread credential recheck")
	}
	return true, nil
}
func (d *oauthMCPThreadDAO) AuthorName(_ context.Context, user string) (*string, error) {
	d.plan.Called("author")
	if user != d.actor.UserID {
		unexpectedHTTPCall(d.t, "OAuth Thread author")
	}
	name := "OAuth author"
	return &name, nil
}
func (d *oauthMCPThreadDAO) LockProjectAuthorization(_ context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	d.plan.Called("project")
	if p != d.actor || project != d.project {
		unexpectedHTTPCall(d.t, "OAuth Thread Project access")
	}
	return model.ProjectAccess{Role: model.ProjectAdmin}, nil
}
func (d *oauthMCPThreadDAO) LockHead(_ context.Context, task string) (*model.ThreadPosition, error) {
	d.plan.Called("head")
	if task != d.task {
		unexpectedHTTPCall(d.t, "OAuth Thread head")
	}
	return nil, nil
}
func (d *oauthMCPThreadDAO) InsertMessage(_ context.Context, m model.ThreadMessage) (model.ThreadMessage, error) {
	d.plan.Called("insert")
	name := "OAuth author"
	expected := model.ThreadMessage{TaskID: d.task, Author: model.ThreadAuthor{UserID: d.actor.UserID, DisplayName: &name}, Body: d.body}
	if !reflect.DeepEqual(m, expected) {
		d.t.Errorf("OAuth Thread insertion: %+v", m)
	}
	m.ID = "d7777777-7777-4777-8777-777777777777"
	return m, nil
}
func (d *oauthMCPThreadDAO) PrepareTimestamp(_ context.Context, m *model.ThreadMessage, head *model.ThreadPosition) error {
	d.plan.Called("time")
	if m.ID != "d7777777-7777-4777-8777-777777777777" || head != nil {
		unexpectedHTTPCall(d.t, "OAuth Thread timestamp")
	}
	m.CreatedAt = d.now
	return nil
}
func (d *oauthMCPThreadDAO) AdvanceHead(_ context.Context, task string, p model.ThreadPosition) error {
	d.plan.Called("advance")
	if task != d.task || p.ID != "d7777777-7777-4777-8777-777777777777" || !p.CreatedAt.Equal(d.now) {
		unexpectedHTTPCall(d.t, "OAuth Thread head advancement")
	}
	return nil
}
func oauthMCPThreadPlan(t *testing.T, f *oauthHTTPFixture, p model.Principal, project, task, body string, credentialError error, barrier func(context.Context) error) {
	want := map[string]int{"transaction": 1, "task": 1, "credential": 1}
	if credentialError == nil {
		for _, name := range []string{"project", "author", "head", "insert", "time", "valid", "advance"} {
			want[name] = 1
		}
	}
	plan := newHTTPCallPlan(t, want)
	dao := &oauthMCPThreadDAO{t: t, plan: plan, actor: p, project: project, task: task, body: body, credentialError: credentialError, expiry: f.Now.Add(time.Hour), barrier: barrier, now: f.Now}
	f.Store.WriteThreadCall = func(ctx context.Context, fn func(store.ThreadScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthMCPThreadScope{dao: dao})
		return oauthHTTPCompletion(e), e
	}
}

type oauthMCPThreadCapture struct {
	plan          *httpCallPlan
	t             *testing.T
	project, task string
}

func (c oauthMCPThreadCapture) CaptureBatch(_ context.Context, _ store.WebhookCaptureDAO, facts []protocol.Fact) error {
	c.plan.Called("capture")
	if len(facts) != 1 || facts[0].Type != protocol.ThreadPosted || facts[0].ProjectID != c.project || facts[0].TaskID != c.task || facts[0].MessageID != "d7777777-7777-4777-8777-777777777777" {
		unexpectedHTTPCall(c.t, "OAuth Thread capture")
	}
	return nil
}

type oauthMCPBotReader struct {
	store.BotReader
	t    *testing.T
	plan *httpCallPlan
	bot  model.Bot
}

func (d *oauthMCPBotReader) Bot(_ context.Context, id string) (model.Bot, error) {
	d.plan.Called("bot")
	if id != d.bot.ID {
		unexpectedHTTPCall(d.t, "OAuth Bot read address")
	}
	return oauthHTTPCloneBot(d.bot), nil
}

type oauthMCPCredentialReader struct {
	t     *testing.T
	plan  *httpCallPlan
	actor model.Principal
	err   error
}

func (d oauthMCPCredentialReader) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.plan.Called("credential")
	if p != d.actor {
		unexpectedHTTPCall(d.t, "OAuth Bot credential")
	}
	return store.ThreadCredential{}, d.err
}
func oauthMCPBotRead(t *testing.T, f *oauthHTTPFixture, p model.Principal, bot model.Bot, err error) {
	want := map[string]int{"snapshot": 1, "credential": 1}
	if err == nil {
		want["bot"] = 1
	}
	plan := newHTTPCallPlan(t, want)
	snapshot := newHTTPTestSnapshot(t)
	snapshot.Credentials = oauthMCPCredentialReader{t: t, plan: plan, actor: p, err: err}
	snapshot.Bots = &oauthMCPBotReader{t: t, plan: plan, bot: bot}
	f.Store.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		return fn(snapshot)
	}
}

type oauthMCPDeleteScope struct {
	store.SessionScope
	dao *oauthMCPDeleteDAO
}

func (s oauthMCPDeleteScope) SessionDAO() store.SessionDAO { return s.dao }
func (s oauthMCPDeleteScope) BotDAO() store.BotWriteDAO    { return s.dao }

type oauthMCPDeleteDAO struct {
	store.SessionDAO
	store.BotWriteDAO
	t           *testing.T
	plan        *httpCallPlan
	p           model.Principal
	bot         model.Bot
	deletion    store.DeleteBot
	afterBot    bool
	credentials int
}

func (d *oauthMCPDeleteDAO) LockCredential(_ context.Context, p model.Principal, now time.Time) error {
	d.plan.Called("credential")
	d.credentials++
	if p != d.p || now.IsZero() {
		unexpectedHTTPCall(d.t, "OAuth deletion credential")
	}
	if d.afterBot && d.credentials == 1 {
		return nil
	}
	return model.ErrNotFound
}
func (d *oauthMCPDeleteDAO) Bot(_ context.Context, id string) (model.Bot, error) {
	d.plan.Called("bot")
	if id != d.bot.ID {
		unexpectedHTTPCall(d.t, "OAuth deletion Bot address")
	}
	return oauthHTTPCloneBot(d.bot), nil
}
func (d *oauthMCPDeleteDAO) LockBotSessions(_ context.Context, id string) ([]store.BotSession, error) {
	d.plan.Called("sessions")
	if id != d.bot.ID {
		unexpectedHTTPCall(d.t, "OAuth deletion session lock")
	}
	return []store.BotSession{}, nil
}
func (d *oauthMCPDeleteDAO) RevokeBotSessions(_ context.Context, id string) error {
	d.plan.Called("revoke")
	if id != d.bot.ID {
		unexpectedHTTPCall(d.t, "OAuth deletion session revoke")
	}
	return nil
}
func (d *oauthMCPDeleteDAO) SaveBotDeletion(_ context.Context, id string, deletion *model.BotDeletion) (model.Bot, error) {
	d.plan.Called("save")
	if id != d.bot.ID || deletion == nil || deletion.DeletionID != d.deletion.DeletionID || deletion.RequestedVersion != d.deletion.Version {
		unexpectedHTTPCall(d.t, "OAuth deletion candidate")
	}
	out := d.bot
	out.Deletion = deletion
	out.Version++
	return out, nil
}
func oauthMCPDeleteRefused(t *testing.T, f *oauthHTTPFixture, p model.Principal, bot model.Bot, input store.DeleteBot, afterBot bool) {
	want := map[string]int{"transaction": 1, "credential": 1}
	if afterBot {
		want["credential"] = 2
		for _, name := range []string{"bot", "sessions", "revoke", "save"} {
			want[name] = 1
		}
	}
	plan := newHTTPCallPlan(t, want)
	dao := &oauthMCPDeleteDAO{t: t, plan: plan, p: p, bot: bot, deletion: input, afterBot: afterBot}
	f.Store.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthMCPDeleteScope{dao: dao})
		return oauthHTTPCompletion(e), e
	}
}

type oauthMCPBotCreationDAO struct {
	store.BotWriteDAO
	t     *testing.T
	plan  *httpCallPlan
	p     model.Principal
	bot   model.Bot
	reads int
}

func (d *oauthMCPBotCreationDAO) Credential(_ context.Context, p model.Principal) error {
	d.plan.Called("credential")
	if p != d.p {
		unexpectedHTTPCall(d.t, "OAuth Bot creation principal")
	}
	return nil
}
func (d *oauthMCPBotCreationDAO) LockCreation(_ context.Context, id string) error {
	d.plan.Called("lock")
	if id != d.bot.ID {
		unexpectedHTTPCall(d.t, "OAuth Bot creation lock")
	}
	return nil
}
func (d *oauthMCPBotCreationDAO) Bot(_ context.Context, id string) (model.Bot, error) {
	d.plan.Called("read")
	if id != d.bot.ID {
		unexpectedHTTPCall(d.t, "OAuth Bot creation read")
	}
	d.reads++
	if d.reads == 1 {
		return model.Bot{}, model.ErrNotFound
	}
	return oauthHTTPCloneBot(d.bot), nil
}
func (d *oauthMCPBotCreationDAO) Worker(_ context.Context, user, worker string) error {
	d.plan.Called("worker")
	if user != d.p.UserID || worker != d.bot.WorkerID {
		unexpectedHTTPCall(d.t, "OAuth Bot creation Worker")
	}
	return nil
}
func (d *oauthMCPBotCreationDAO) InsertBot(_ context.Context, bot model.Bot) error {
	d.plan.Called("insert")
	expected := model.Bot{ID: d.bot.ID, OwnerUserID: d.p.UserID, WorkerID: d.bot.WorkerID, Name: d.bot.Name, RequestFingerprint: d.bot.RequestFingerprint, ResolvedConfiguration: d.bot.ResolvedConfiguration}
	if !reflect.DeepEqual(bot, expected) {
		d.t.Errorf("OAuth Bot creation candidate: %+v", bot)
	}
	return nil
}

type oauthMCPBotCreationScope struct{ dao store.BotWriteDAO }

func (s oauthMCPBotCreationScope) BotDAO() store.BotWriteDAO { return s.dao }
func oauthMCPCreateBot(t *testing.T, f *oauthHTTPFixture, p model.Principal, bot model.Bot) {
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "credential": 2, "lock": 1, "read": 2, "worker": 1, "insert": 1})
	dao := &oauthMCPBotCreationDAO{t: t, plan: plan, p: p, bot: bot}
	f.Store.WriteBotCall = func(ctx context.Context, fn func(store.BotScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthMCPBotCreationScope{dao: dao})
		return oauthHTTPCompletion(e), e
	}
}
