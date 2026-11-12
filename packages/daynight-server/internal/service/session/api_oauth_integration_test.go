package session

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const serviceOAuthOrigin = "https://session.example"

func issueServiceOAuth(t *testing.T, f serviceFixture, user string, api bool) (oauth.IssuedFamily, model.Principal) {
	t.Helper()
	f.service.SetOrigin(serviceOAuthOrigin)
	var issued oauth.IssuedFamily
	var principal model.Principal
	completion, err := f.db.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
		var err error
		resource := serviceOAuthOrigin + "/api/v1"
		if api {
			issued, err = oauth.IssueAPIFamily(t.Context(), scope.CredentialFamilyDAO(), user, resource, time.Now().Add(-time.Minute))
		} else {
			resource = serviceOAuthOrigin + "/mcp"
			issued, err = oauth.IssueFamily(t.Context(), scope.CredentialFamilyDAO(), oauth.IssueInput{UserID: user, ClientID: "recorded-client", Resource: resource, ClientSnapshot: json.RawMessage(`{"clientName":"Recorded client"}`)}, time.Now().Add(-time.Minute))
		}
		if err != nil {
			return err
		}
		identity, err := oauth.AuthenticateAccess(t.Context(), scope.CredentialFamilyDAO(), issued.AccessToken, resource, time.Now())
		principal = identity.Principal
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || principal.CredentialID != issued.AccessID || principal.UserID != user || principal.Kind != model.OAuthCredential {
		t.Fatalf("issue and authenticate Session actor: %+v %+v %v", principal, completion, err)
	}
	return issued, principal
}

func synchronizeServiceSession(t *testing.T, f serviceFixture, v sp.Snapshot) {
	t.Helper()
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}, Controls: &sp.Controls{Revision: "1", Settings: []sp.Setting{}, Commands: []sp.NativeCommand{}}}
	if _, err := f.service.Handle(t.Context(), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
}

func serviceMessage(v sp.Snapshot) sp.Command {
	return sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"API message"}],"expectedTurnId":null}`)}
}

func TestServiceAPIOAuthRotationPreservesSavedActorAndReceipt(t *testing.T) {
	f := newServiceFixture(t)
	issued, actor := issueServiceOAuth(t, f, f.owner.UserID, true)
	v := f.connectWeb(t, f.registerWeb(t))
	synchronizeServiceSession(t, f, v)
	command := serviceMessage(v)
	if receipt, err := f.service.Submit(t.Context(), actor, f.project, f.task, v.SessionID, command); err != nil || receipt.State != "accepted" {
		t.Fatalf("API submit: %+v %v", receipt, err)
	}
	rotated, err := oauth.NewGrantLifecycle(f.db).Rotate(t.Context(), issued.RefreshToken, oauth.APIClientID, issued.Grant.Resource, func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	newActor := model.Principal{Kind: model.OAuthCredential, UserID: actor.UserID, CredentialID: rotated.AccessID}
	if receipt, err := f.service.Submit(t.Context(), newActor, f.project, f.task, v.SessionID, command); err != nil || receipt.State != "accepted" {
		t.Fatalf("same user and intent retry: %+v %v", receipt, err)
	}
	var saved model.Principal
	var count int
	if err = f.db.Pool.QueryRow(t.Context(), `SELECT actor_user_id::text,credential_id::text,credential_kind,(SELECT count(*) FROM session_operations WHERE session_id=$1) FROM session_operations WHERE session_id=$1 AND operation_id=$2`, v.SessionID, command.OperationID).Scan(&saved.UserID, &saved.CredentialID, &saved.Kind, &count); err != nil || saved != actor || count != 1 {
		t.Fatalf("rotation changed durable Actor or duplicated intent: %+v count=%d %v", saved, count, err)
	}
	if offers, err := f.service.Poll(t.Context(), v.ControllerFence); err != nil || len(offers) != 1 {
		t.Fatalf("still-valid old Actor after rotation: %v %v", offers, err)
	}
	if _, err = f.db.Pool.Exec(t.Context(), `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	begin, err := f.service.Handle(t.Context(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID})
	if err != nil || begin["type"] != "receipt_ack" {
		t.Fatalf("expired original Actor begin: %v %v", begin, err)
	}
	if receipt, ok := begin["operation"].(sp.Operation); !ok || receipt.State != "rejected" {
		t.Fatalf("new access revived old dispatch: %v", begin)
	}
	receipt, err := f.service.TaskOperation(t.Context(), newActor, f.project, f.task, v.SessionID, command.OperationID)
	if err != nil || receipt.Operation.State != "rejected" || !receipt.CurrentBinding {
		t.Fatalf("fresh access receipt: %+v %v", receipt, err)
	}
	if _, err = f.service.TaskOperation(t.Context(), actor, f.project, f.task, v.SessionID, command.OperationID); err == nil {
		t.Fatal("expired access read receipt")
	}
	if again, err := f.service.Submit(t.Context(), newActor, f.project, f.task, v.SessionID, command); err != nil || again.State != "rejected" {
		t.Fatalf("same intent revived rejected operation: %+v %v", again, err)
	}
	if offers, err := f.service.Poll(t.Context(), v.ControllerFence); err != nil || len(offers) != 0 {
		t.Fatalf("rejected operation replayed: %v %v", offers, err)
	}
	if _, err = f.db.Pool.Exec(t.Context(), `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	receipt, err = f.service.TaskOperation(t.Context(), newActor, f.project, f.task, v.SessionID, command.OperationID)
	if err != nil || receipt.CurrentBinding || receipt.Operation.State != "rejected" {
		t.Fatalf("historical receipt changed identity: %+v %v", receipt, err)
	}
}

func TestServiceAPIOAuthControlAndMCPSubset(t *testing.T) {
	f := newServiceFixture(t)
	_, api := issueServiceOAuth(t, f, f.owner.UserID, true)
	_, mcp := issueServiceOAuth(t, f, f.owner.UserID, false)
	v := f.connectWeb(t, f.registerWeb(t))
	synchronizeServiceSession(t, f, v)
	if _, _, _, err := f.service.BrowserPoll(t.Context(), api, f.project, f.task, v.SessionID, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := f.service.BrowserPoll(t.Context(), mcp, f.project, f.task, v.SessionID, ""); err == nil {
		t.Fatal("MCP acquired general browser access")
	}
	control := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: "refresh_controls", Payload: json.RawMessage(`{}`)}
	if _, err := f.service.Submit(t.Context(), mcp, f.project, f.task, v.SessionID, control); err == nil {
		t.Fatal("MCP submitted general control")
	}
	if receipt, err := f.service.Submit(t.Context(), api, f.project, f.task, v.SessionID, control); err != nil || receipt.State != "accepted" {
		t.Fatalf("API control: %+v %v", receipt, err)
	}
	message := serviceMessage(v)
	if _, err := f.service.Submit(t.Context(), mcp, f.project, f.task, v.SessionID, message); err != nil {
		t.Fatal(err)
	}
	if receipt, err := f.service.TaskOperation(t.Context(), mcp, f.project, f.task, v.SessionID, message.OperationID); err != nil || receipt.Operation.State != "accepted" {
		t.Fatalf("original MCP receipt: %+v %v", receipt, err)
	}
	if _, err := f.service.Register(t.Context(), api, f.project, f.task, f.registration); err == nil {
		t.Fatal("API registered producer")
	}
	if _, err := f.service.Grant(t.Context(), api, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}); err == nil {
		t.Fatal("API issued Controller grant")
	}
	if _, err := f.service.BeginArchive(t.Context(), api, f.project, f.task, v.SessionID, core.ArchiveV1Upload); err == nil {
		t.Fatal("API entered producer archive upload")
	}
}

func TestServiceAPIOAuthIndependentAndBotArchiveRetainParentPAT(t *testing.T) {
	for _, bot := range []bool{false, true} {
		t.Run(map[bool]string{false: "standalone", true: "bot"}[bot], func(t *testing.T) {
			f := newServiceFixture(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := files.Close(); err != nil {
					t.Error(err)
				}
			})
			var v sp.Snapshot
			if bot {
				var out core.BotRegistrationResult
				f, out = serviceBoundBot(t, f, files)
				v = out.Session
			} else {
				engine := core.NewEngine(files)
				t.Cleanup(func() {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					if err := engine.Stop(ctx); err != nil {
						t.Error(err)
					}
				})
				f.service = New(f.db, engine)
				v, err = f.service.RegisterTest(t.Context(), f.owner, sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"})
				if err != nil {
					t.Fatal(err)
				}
			}
			_, api := issueServiceOAuth(t, f, f.owner.UserID, true)
			_, mcp := issueServiceOAuth(t, f, f.owner.UserID, false)
			if snapshot, err := f.service.TestSnapshot(t.Context(), api, v.SessionID); err != nil || snapshot.SessionID != v.SessionID {
				t.Fatalf("API independent snapshot: %+v %v", snapshot, err)
			}
			if _, err := f.service.TestSnapshot(t.Context(), mcp, v.SessionID); err == nil {
				t.Fatal("MCP acquired independent Session")
			}
			if _, err := f.db.Pool.Exec(t.Context(), `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"') WHERE id=$1`, v.SessionID); err != nil {
				t.Fatal(err)
			}
			data := prepareServiceArchive(t, t.Context(), f.service, f.owner, "", "", v)
			if err := publishServiceArchive(t.Context(), f.service, f.owner, "", "", v.SessionID, data); err != nil {
				t.Fatal(err)
			}
			archive, err := f.service.ArchiveContent(t.Context(), api, "", "", v.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(archive.Data, data) {
				t.Fatal("API archive body changed")
			}
			if err := archive.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := f.service.BeginArchive(t.Context(), mcp, "", "", v.SessionID, core.ArchiveV1Read); err == nil {
				t.Fatal("MCP acquired independent readable archive")
			}
			if _, err := f.db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.owner.CredentialID); err != nil {
				t.Fatal(err)
			}
			if _, err := f.service.TestSnapshot(t.Context(), api, v.SessionID); err == nil {
				t.Fatal("API bypassed revoked parent PAT")
			}
			if _, err := f.service.BeginArchive(t.Context(), api, "", "", v.SessionID, core.ArchiveV1Read); err == nil {
				t.Fatal("API archive preflight bypassed revoked parent PAT")
			}
		})
	}
}
