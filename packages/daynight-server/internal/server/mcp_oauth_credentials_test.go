package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgfamily "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestOAuthAccessBusinessAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := projectTestStore(t)
	handler := projectTestHandler(t, db, io.Discard)
	project := taskProject(t, handler)
	task := createHTTPWorkerTask(t, handler, project.ID, "OAuth Thread")
	now := time.Now().UTC().Truncate(time.Microsecond)
	grantID, accessID := uuid.NewString(), uuid.NewString()
	token, refresh := secret.Random(model.OAuthAccessPrefix), secret.Random("dnmcr_")
	issue := store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: grantID, UserID: handler.principal.UserID, ClientID: "client", ClientSnapshot: json.RawMessage(`{"name":"client"}`), Resource: "https://daynight.test/mcp", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}, AccessID: accessID, AccessHash: secret.Hash(token), RefreshHash: secret.Hash(refresh), AccessExpiresAt: now.Add(time.Hour)}
	completion, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("issue: %v %v", completion, err)
	}
	auth := oauthservice.NewAuthenticator(db)
	identity, err := auth.AuthenticateAccess(ctx, token, issue.Grant.Resource)
	if err != nil || identity.GrantID != grantID || identity.Principal.CredentialID != accessID {
		t.Fatalf("authenticate: %+v %v", identity, err)
	}
	if _, err = auth.AuthenticateAccess(ctx, token, "https://other.test/mcp"); err == nil {
		t.Fatal("wrong resource accepted")
	}
	p := identity.Principal
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Exercise the production composition, which constructs OAuth admission
	// from the same store as the business services.
	config := configuredTestConfig()
	config.PublicOrigin = "https://daynight.test"
	config.UniAuthCallbackURL = config.PublicOrigin + "/api/v1/auth/callback"
	production, err := newTestHandler(Dependencies{Store: db, Ready: db.Ready, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	productionServer := httptest.NewServer(httpx.RequestLogging(logger, production))
	defer productionServer.Close()
	defer production.(Handler).Shutdown(context.Background())
	productionClient := mcpPATClient(t, productionServer.URL, token)
	if _, err = productionClient.ListTools(ctx, nil); err != nil {
		t.Fatalf("production MCP OAuth: %v", err)
	}
	otherUser, privateTeam := assignmentHTTPUser(t, db), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'Private')`, privateTeam); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, privateTeam, otherUser); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		team      string
		wantError bool
	}{{"personal", false}, {privateTeam, true}} {
		result, err := productionClient.CallTool(ctx, &sdk.CallToolParams{Name: "team_show", Arguments: map[string]any{"team": tc.team}})
		if err != nil || result.IsError != tc.wantError {
			t.Fatalf("OAuth Team read %s: %#v %v", tc.team, result, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Data struct {
				Membership struct {
					UserID string `json:"userId"`
				} `json:"membership"`
			} `json:"data"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if (!tc.wantError && envelope.Data.Membership.UserID != p.UserID) || (tc.wantError && envelope.Error.Code != "not_found") {
			t.Fatalf("OAuth Team read: %s", raw)
		}
	}
	entry, err := mcphttp.New(identityservice.New(db, nil, ""), "https://daynight.test", nil, logger, auth)
	if err != nil {
		t.Fatal(err)
	}
	if err := entry.RegisterTool(&sdk.Tool{Name: "actor", InputSchema: map[string]any{"type": "object"}, OutputSchema: map[string]any{"type": "object"}}, mcphttp.BudgetControl, func(_ context.Context, actor mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
		return mcphttp.ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "access": actor.Principal.CredentialID, "authority": actor.AuthorityRef.ID, "kind": actor.AuthorityRef.Kind}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(httpx.RequestLogging(logger, entry))
	defer httpServer.Close()
	defer entry.Shutdown(context.Background())
	client := sdk.NewClient(&sdk.Implementation{Name: "oauth-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: httpServer.URL, HTTPClient: &http.Client{Transport: mcpPATTransport{token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "actor", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("MCP call: %v %+v", err, result)
	}
	bytes, _ := json.Marshal(result.StructuredContent)
	var envelope struct {
		Data struct{ User, Access, Authority, Kind string }
	}
	if err := json.Unmarshal(bytes, &envelope); err != nil || envelope.Data.User != p.UserID || envelope.Data.Access != accessID || envelope.Data.Authority != grantID || envelope.Data.Kind != "oauth" {
		t.Fatalf("MCP actor: %s %v", bytes, err)
	}
	// A replacement access token retains the same authorization identity.
	replacement := secret.Random(model.OAuthAccessPrefix)
	replacementID := uuid.NewString()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, replacementID, grantID, p.UserID, secret.Hash(replacement), now, issue.AccessExpiresAt); err != nil {
		t.Fatal(err)
	}
	replacementSession, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: httpServer.URL, HTTPClient: &http.Client{Transport: mcpPATTransport{token: replacement}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer replacementSession.Close()
	replacementResult, err := replacementSession.CallTool(ctx, &sdk.CallToolParams{Name: "actor", Arguments: map[string]any{}})
	if err != nil || replacementResult.IsError {
		t.Fatalf("replacement access: %v", err)
	}
	replacementBytes, _ := json.Marshal(replacementResult.StructuredContent)
	var replacementActor struct {
		Data struct{ User, Access, Authority, Kind string }
	}
	if err := json.Unmarshal(replacementBytes, &replacementActor); err != nil || replacementActor.Data.Access != replacementID || replacementActor.Data.Authority != grantID {
		t.Fatalf("replacement actor: %s %v", replacementBytes, err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("OAuth on REST: %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodPost, taskPath(task)+"/worker-claim", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("OAuth on worker endpoint: %d", response.Code)
	}
	threads := taskservice.NewTaskThreads(db)
	if _, err = threads.Post(ctx, p, project.ID, task.ID, taskservice.CreateThreadMessage{Body: "OAuth author"}); err != nil {
		t.Fatalf("thread post: %v", err)
	}
	forged := p
	forged.CredentialID = uuid.NewString()
	if _, err = threads.Post(ctx, forged, project.ID, task.ID, taskservice.CreateThreadMessage{Body: "forged"}); err == nil {
		t.Fatal("forged access ID accepted")
	}
	worker := uuid.NewString()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, p.UserID, worker); err != nil {
		t.Fatal(err)
	}
	bots := botservice.New(db)
	bot, err := bots.Create(ctx, p, botcore.CreateBot{ID: uuid.NewString(), Name: "OAuth Bot", ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}})
	if err != nil {
		t.Fatalf("bot create: %v", err)
	}
	if _, err = bots.Get(ctx, p, bot.ID); err != nil {
		t.Fatalf("bot read: %v", err)
	}
	if _, err = bots.Get(ctx, forged, bot.ID); err == nil {
		t.Fatal("forged bot credential accepted")
	}
	// The Thread call first waits on the task row. Expiry during that wait
	// must be checked before any message is committed.
	lock, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	if _, err = lock.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, accessID); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan error, 1)
	go func() {
		_, err := threads.Post(ctx, p, project.ID, task.ID, taskservice.CreateThreadMessage{Body: "expired while waiting"})
		resultCh <- err
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	wait := func(query string, args ...any) {
		t.Helper()
		for {
			var ready bool
			if err := db.Pool.QueryRow(ctx, query, args...).Scan(&ready); err != nil {
				t.Fatal(err)
			}
			if ready {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-ticker.C:
			}
		}
	}
	wait(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)))`, int32(lock.Conn().PgConn().PID()))
	wait(`SELECT expires_at<=clock_timestamp() FROM oauth_access_tokens WHERE id=$1`, accessID)
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-resultCh:
		if err == nil {
			t.Fatal("expired Thread write accepted")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=$2 WHERE id=$1`, accessID, issue.AccessExpiresAt); err != nil {
		t.Fatal(err)
	}
	// Bot deletion holds the access lock while waiting for the Bot row.
	// Its final admission must reject an access token that expires in that wait.
	botLock, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer botLock.Rollback(context.Background())
	if _, err = botLock.Exec(ctx, `SELECT id FROM bots WHERE id=$1 FOR UPDATE`, bot.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, accessID); err != nil {
		t.Fatal(err)
	}
	deletions := botservice.NewDeletions(db, nil, sessioncore.NewEngine(nil))
	deletion := store.DeleteBot{Version: bot.Version, DeletionID: uuid.NewString()}
	go func() { _, err := deletions.DeleteBot(ctx, p, bot.ID, deletion); resultCh <- err }()
	wait(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)))`, int32(botLock.Conn().PgConn().PID()))
	wait(`SELECT expires_at<=clock_timestamp() FROM oauth_access_tokens WHERE id=$1`, accessID)
	if err = botLock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-resultCh:
		if err == nil {
			t.Fatal("expired Bot deletion accepted")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=$2 WHERE id=$1`, accessID, issue.AccessExpiresAt); err != nil {
		t.Fatal(err)
	}

	// A business-held shared access lock prevents family revocation from
	// committing until the business transaction has finished.
	held := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_, e := db.WriteThread(ctx, func(scope store.ThreadScope) error {
			if _, e := scope.CredentialDAO().Credential(ctx, p); e != nil {
				return e
			}
			close(held)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		resultCh <- e
	}()
	select {
	case <-held:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	revokeTx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revokeTx.Rollback(context.Background())
	revoked := make(chan error, 1)
	go func() { _, e := pgfamily.NewDAO(revokeTx).RevokeFamily(ctx, grantID, time.Now()); revoked <- e }()
	wait(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')`, int32(revokeTx.Conn().PgConn().PID()))
	close(release)
	select {
	case err = <-resultCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case err = <-revoked:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}

	// Both Thread and Bot wait on the uncommitted revocation. After commit
	// their stale principal cannot pass the shared credential lock.
	go func() {
		_, e := threads.Post(ctx, p, project.ID, task.ID, taskservice.CreateThreadMessage{Body: "revoke wait"})
		resultCh <- e
	}()
	go func() { _, e := deletions.DeleteBot(ctx, p, bot.ID, deletion); resultCh <- e }()
	wait(`SELECT count(*) >= 2 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid))`, int32(revokeTx.Conn().PgConn().PID()))
	if err = revokeTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case e := <-resultCh:
			if e == nil {
				t.Fatal("revoked waiting business call accepted")
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if _, err = auth.AuthenticateAccess(ctx, token, issue.Grant.Resource); err == nil {
		t.Fatal("revoked authentication accepted")
	}
	if _, err = threads.Post(ctx, p, project.ID, task.ID, taskservice.CreateThreadMessage{Body: "revoked"}); err == nil {
		t.Fatal("revoked thread accepted")
	}
	if _, err = bots.Get(ctx, p, bot.ID); err == nil {
		t.Fatal("revoked bot accepted")
	}
	if _, err = productionClient.ListTools(ctx, nil); err == nil {
		t.Fatal("production MCP accepted revoked access")
	}
	if _, err = session.CallTool(ctx, &sdk.CallToolParams{Name: "actor", Arguments: map[string]any{}}); err == nil {
		t.Fatal("revoked MCP accepted")
	}
}
