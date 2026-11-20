package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type receiptScopeDAO struct {
	store.SessionDAO
	principal                       model.Principal
	sessionID, operationID, claimID string
	reads                           int
	projectErr                      error
}

func (d *receiptScopeDAO) LockTask(context.Context, string, string) (store.SessionTask, error) {
	return store.SessionTask{Status: "done"}, nil
}
func (d *receiptScopeDAO) LockCredential(_ context.Context, p model.Principal, _ time.Time) error {
	if p != d.principal {
		return errors.New("wrong principal")
	}
	return nil
}
func (d *receiptScopeDAO) LockOAuthCredential(_ context.Context, p model.Principal, bindings []store.OAuthBinding, _ time.Time) error {
	if p != d.principal || len(bindings) != 2 || bindings[1].Resource != "https://daynight.test/mcp" {
		return errors.New("wrong MCP binding")
	}
	return nil
}
func (d *receiptScopeDAO) ProjectAccess(context.Context, string, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{Role: model.ProjectAdmin}, d.projectErr
}
func (d *receiptScopeDAO) SessionLocation(context.Context, string) (store.SessionLocation, error) {
	return store.SessionLocation{ProjectID: testProjectID, TaskID: testTargetID, SessionID: d.sessionID}, nil
}
func (d *receiptScopeDAO) SessionBotID(context.Context, string) (*string, error) { return nil, nil }
func (d *receiptScopeDAO) LockSession(context.Context, string) (store.SessionRecord, error) {
	return store.SessionRecord{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: d.sessionID, ClaimID: d.claimID}}, Identity: sp.Identity{ProjectID: testProjectID, TaskID: testTargetID}}}, nil
}
func (d *receiptScopeDAO) SessionOperation(_ context.Context, id, operation string) (store.SessionOperation, error) {
	d.reads++
	if id != d.sessionID || operation != d.operationID {
		return store.SessionOperation{}, errors.New("wrong receipt")
	}
	return store.SessionOperation{Receipt: sp.Operation{Fence: sp.Fence{SessionID: id, ClaimID: d.claimID, ExecutionGeneration: "1"}, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", State: "provider_accepted"}}, nil
}

type receiptScope struct{ dao *receiptScopeDAO }

func (s receiptScope) SessionDAO() store.SessionDAO { return s.dao }
func (s receiptScope) BotDAO() store.BotWriteDAO    { return nil }

type receiptWriter struct{ scope receiptScope }

func (w receiptWriter) WriteSession(_ context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	if err := fn(w.scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestScopedSessionOperationUsesReceiptAuthorizationAndCurrentPolicy(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		t.Run(string(kind), func(t *testing.T) {
			f := newEntryFixture(t)
			a := scopedTestAuthorization(t, "session:read")
			token := "token"
			if kind == scopepolicy.MCP {
				policy, err := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"session:read"}, 1)
				if err != nil {
					t.Fatal(err)
				}
				a.Principal.Kind, a.Profile, a.Policy, token = model.OAuthCredential, model.ScopedMCPProfile, &policy, "dnmcp_token"
			}
			auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{token: a}}
			if err := f.entry.EnableScopedAuthentication(auth); err != nil {
				t.Fatal(err)
			}
			args := sendArguments()
			for _, key := range []string{"claimId", "executionGeneration", "expectedTurnId", "text"} {
				delete(args, key)
			}
			dao := &receiptScopeDAO{principal: a.Principal, sessionID: args["sessionId"].(string), operationID: args["operationId"].(string), claimID: "33333333-3333-4333-8333-333333333333"}
			scope := receiptScope{dao}
			engine := core.NewEngine(nil)
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				if err := engine.Stop(ctx); err != nil {
					t.Error(err)
				}
			})
			service := ss.New(receiptWriter{scope}, engine)
			service.SetOrigin("https://daynight.test")
			current := a
			checks := 0
			resolve := func(_ context.Context, got store.SessionScope, original model.CredentialAuthorization) (model.CredentialAuthorization, error) {
				checks++
				if got.SessionDAO() != dao || original.Principal != a.Principal || original.Profile != a.Profile {
					t.Error("policy read escaped receipt transaction or changed identity")
				}
				return current, nil
			}
			snapshot := func(context.Context, store.SnapshotScope, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
				t.Error("unexpected snapshot")
				return model.CredentialAuthorization{}, errors.New("unexpected snapshot")
			}
			if err := RegisterSessionTools(f.entry, ScopedSessionSendModule(service, resolve, snapshot)); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", token)
			assertNoDiscoveredOutputSchemas(t, client, "task_session_send", "task_session_operation")
			c := &structClient{t: t, client: client}
			out := c.call("task_session_operation", args, false)
			data := object(t, out["data"])
			if data["currentBinding"] != false || object(t, data["operation"])["operationId"] != dao.operationID || dao.reads != 1 || checks != 1 {
				t.Fatalf("historical receipt: %#v reads=%d checks=%d", out, dao.reads, checks)
			}
			policy, err := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"task:read"}, 2)
			if err != nil {
				t.Fatal(err)
			}
			current.Policy = &policy
			out = c.call("task_session_operation", args, true)
			if object(t, out["error"])["code"] != "insufficient_scope" || out["data"] != nil || dao.reads != 1 || checks != 2 {
				t.Fatalf("revocation: %#v reads=%d checks=%d", out, dao.reads, checks)
			}
			dao.projectErr = model.ErrNotFound
			out = c.call("task_session_operation", args, true)
			if object(t, out["error"])["code"] != "forbidden" || dao.reads != 1 {
				t.Fatalf("project visibility changed: %#v", out)
			}
			out = c.call("task_session_send", sendArguments(), true)
			if object(t, out["error"])["code"] != "forbidden" {
				t.Fatalf("send enabled: %#v", out)
			}
			tools, err := client.ListTools(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			var expected []*sdk.Tool
			if err := json.Unmarshal(sessionSendDefinitions, &expected); err != nil {
				t.Fatal(err)
			}
			for _, want := range expected {
				found := false
				for _, actual := range tools.Tools {
					if actual.Name == want.Name {
						found = true
						if !reflect.DeepEqual(actual.InputSchema, want.InputSchema) {
							t.Fatalf("schema changed: %s", actual.Name)
						}
					}
				}
				if !found {
					t.Fatalf("tool disappeared: %s", want.Name)
				}
			}
		})
	}
}

func TestScopedSessionOperationRequiresReadSources(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterSessionTools(f.entry, ScopedSessionSendModule(sessionSendMock{t: t}, nil, nil)); err == nil {
		t.Fatal("missing sources accepted")
	}
}
