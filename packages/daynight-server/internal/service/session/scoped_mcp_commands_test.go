package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskprops "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type combinedAuthenticator struct{ authorization model.CredentialAuthorization }

func (a combinedAuthenticator) Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error) {
	return a.authorization.Principal, nil
}
func (a combinedAuthenticator) AuthenticateScoped(_ context.Context, kind model.CredentialKind, token, resource string) (model.CredentialAuthorization, mcphttp.AuthorityRef, error) {
	if kind != model.PATCredential || token != "token" || resource != "https://daynight.test/mcp" {
		return model.CredentialAuthorization{}, mcphttp.AuthorityRef{}, model.Unauthenticated(nil)
	}
	return a.authorization, mcphttp.AuthorityRef{Kind: "pat", ID: a.authorization.Principal.CredentialID}, nil
}

type combinedTransport struct{ base http.RoundTripper }

func (tr combinedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer token")
	return tr.base.RoundTrip(r)
}

func TestScopedMCPCommandsAndReceiptsShareOneService(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user := testsupport.ServicePrincipal(t, db)
	credential := uuid.NewString()
	hash := sha256.Sum256([]byte(credential))
	_, err = db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,$3,'combined test',now(),now()+interval '1 day',ARRAY['session:read','session:send'],1)`, credential, user.UserID, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	actor := model.Principal{Kind: model.PATCredential, UserID: user.UserID, CredentialID: credential}
	project, task := uuid.NewString(), uuid.NewString()
	registration := sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	properties, err := taskprops.WithWorker(model.TaskProperties{}, &model.WorkerClaim{ClaimID: registration.ClaimID, UserID: actor.UserID, WorkerID: registration.WorkerID, WorktreeID: registration.WorktreeID, State: model.WorkerActive, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test"}, Platform: model.PlatformLinux, Phase: model.WorkerExecuting, ClaimedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Session test','https://github.com/example/session.git')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id,version,updated_at) SELECT $1,id,1,now() FROM teams WHERE personal_user_id=$2`, []any{project, actor.UserID}},
		{`INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Session test','in_progress')`, []any{task, project}},
		{`INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, []any{task, string(properties["worker"])}},
	} {
		if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	engine := core.NewEngine(nil)
	t.Cleanup(func() {
		stop, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		if err := engine.Stop(stop); err != nil {
			t.Error(err)
		}
	})
	legacy := ss.New(db, engine)
	v, err := legacy.Register(ctx, actor, project, task, registration)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := legacy.Grant(ctx, actor, project, task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	v, err = legacy.Connect(ctx, grant.Token, hello, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err = legacy.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	service, err := ss.NewScopedCommands(db, engine, ss.TransactionCommandAuthorization{Origin: "https://daynight.test"})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:read", "session:send"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := combinedAuthenticator{authorization: model.CredentialAuthorization{Principal: actor, Profile: model.ScopedPATProfile, Policy: &policy}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := mcphttp.New(auth, "https://daynight.test", []string{"https://client.test"}, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = entry.EnableScopedAuthentication(auth); err != nil {
		t.Fatal(err)
	}
	source := ss.NewSessionAuthorizationSource("https://daynight.test")
	if err = mcphttp.RegisterSessionTools(entry, mcphttp.ScopedSessionCommandSendModule(service, source.SessionWrite, source.SessionSnapshot)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(entry)
	t.Cleanup(func() {
		stop, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		if err := entry.Shutdown(stop); err != nil {
			t.Error(err)
		}
		server.Close()
	})
	client := sdk.NewClient(&sdk.Implementation{Name: "test-client", Version: "1"}, nil)
	transport := &sdk.StreamableClientTransport{Endpoint: server.URL, HTTPClient: &http.Client{Transport: combinedTransport{http.DefaultTransport}}, DisableStandaloneSSE: true, MaxRetries: -1}
	connection, err := client.Connect(ctx, transport, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	protected := service.Execution
	if err := protected.SetCommandAdmission(nil); err == nil {
		t.Fatal("installed command admission was removed")
	}
	if err := protected.SetCommandAdmission(func(context.Context, store.SessionScope, model.Principal, scopepolicy.Operation) error { return nil }); err == nil {
		t.Fatal("installed command admission was replaced")
	}
	service.Execution = legacy.Execution
	operationID := uuid.NewString()
	args := map[string]any{"projectId": project, "taskId": task, "sessionId": v.SessionID, "claimId": v.ClaimID, "executionGeneration": v.ExecutionGeneration, "operationId": operationID, "expectedTurnId": nil, "text": "hello"}
	call := func(name string, input map[string]any, code string) map[string]any {
		t.Helper()
		result, err := connection.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: input})
		if err != nil || result.IsError != (code != "") {
			t.Fatalf("%s result=%v error=%v", name, result, err)
		}
		bytes, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		if err = json.Unmarshal(bytes, &out); err != nil {
			t.Fatal(err)
		}
		if code != "" {
			failure, ok := out["error"].(map[string]any)
			if !ok || failure["code"] != code || out["data"] != nil {
				t.Fatalf("%s refusal: %s", name, bytes)
			}
		}
		return out
	}
	read := map[string]any{"projectId": project, "taskId": task, "sessionId": v.SessionID, "operationId": operationID}
	call("task_session_send", args, "")
	result := call("task_session_operation", read, "")
	if result["data"] == nil {
		t.Fatal("accepted receipt missing")
	}
	set := func(scopes []string) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=$2,scope_version=scope_version+1 WHERE id=$1`, credential, scopes); err != nil {
			t.Fatal(err)
		}
	}
	set([]string{"session:read"})
	args["operationId"] = uuid.NewString()
	call("task_session_send", args, "insufficient_scope")
	call("task_session_operation", read, "")
	set([]string{"session:send"})
	call("task_session_operation", read, "insufficient_scope")
	args["operationId"] = operationID
	call("task_session_send", args, "insufficient_scope")
	args["operationId"] = uuid.NewString()
	call("task_session_send", args, "")
}
