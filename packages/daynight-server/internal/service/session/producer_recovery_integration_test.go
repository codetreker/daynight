package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestScopedBotRecoveryReplacesRetiredConnectionParent(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	f, registered := serviceBoundBot(t, newServiceFixture(t), files)
	f.service.SetOrigin("https://recovery.example")
	if _, err = f.db.Pool.Exec(ctx, `UPDATE workers SET telemetry='{"machine":{"ID":"same-machine","Name":"Same machine"}}' WHERE user_id=$1 AND worker_id=$2`, f.owner.UserID, registered.Bot.WorkerID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:produce'],scope_version=1 WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	second := model.Principal{Kind: model.PATCredential, UserID: f.owner.UserID, CredentialID: uuid.NewString()}
	hash := sha256.Sum256([]byte(second.CredentialID))
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,$3,'recovery',now(),now()+interval '1 day',ARRAY['session:produce'],1)`, second.CredentialID, second.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	source := TransactionCommandAuthorization{}
	svc, err := NewScoped(f.db, f.service.engine, source.SessionWrite)
	if err != nil {
		t.Fatal(err)
	}
	v := registered.Session
	grantInput := core.BotGrant{BotVersion: registered.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "bootstrap"}}
	grant, err := svc.GrantBot(ctx, f.owner, registered.Bot.WorkerID, registered.Bot.ID, grantInput)
	if err != nil {
		t.Fatal(err)
	}
	sourceEpoch := uuid.NewString()
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: "codex", SourceEpoch: sourceEpoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	connected, err := svc.Connect(ctx, grant.Token, hello, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	native := "original-native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
	if _, err = svc.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: connected.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	identity := core.BotRecoveryIdentity{BotRecoveryVersion: 1, ServiceOrigin: "https://recovery.example", RecoveryIdentity: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))}
	binding := core.BotRecoveryBinding{SessionID: v.SessionID, TestExecutionID: v.TestExecutionID, NativeSessionID: &native}
	if _, err = svc.RegisterBotRecovery(ctx, f.owner, registered.Bot.WorkerID, registered.Bot.ID, core.BotRecoveryRegistration{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), BotVersion: registered.Bot.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE task_sessions SET grant_expires_at=now()-interval '1 second' WHERE id=$1`, v.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	token := "dncontroller_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32))
	input := core.BotRecoveryGrant{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), ExpectedHostingGeneration: 1, ControllerToken: token, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"}}
	out, err := svc.GrantBotRecovery(ctx, second, registered.Bot.WorkerID, registered.Bot.ID, input)
	if err != nil || !out.Current {
		t.Fatalf("recovery grant: %+v %v", out, err)
	}
	var parent, connection string
	var lease *time.Time
	if err = f.db.Pool.QueryRow(ctx, `SELECT parent_credential_id::text,connection_parent_credential_id::text,connection_expires_at FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&parent, &connection, &lease); err != nil {
		t.Fatal(err)
	}
	if parent != second.CredentialID || connection != f.owner.CredentialID || lease != nil {
		t.Fatalf("recovery failed to retire exact connection: %q %q %v", parent, connection, lease)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=now()+interval '1 day' WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: connected.ControllerFence}); err == nil {
		t.Fatal("retired A connection remained active with valid A")
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	if err = svc.AuthenticateController(ctx, token); err != nil {
		t.Fatalf("recovered B grant rejected: %v", err)
	}
	hello.ControllerFence = connected.ControllerFence
	next, err := svc.Connect(ctx, token, hello, uuid.NewString())
	if err != nil {
		t.Fatalf("recovered B connect rejected: %v", err)
	}
	if next.SessionID != connected.SessionID || next.ExecutionGeneration != connected.ExecutionGeneration || next.ConnectionEpoch == connected.ConnectionEpoch {
		t.Fatalf("recovery changed original execution: old=%+v new=%+v", connected.ControllerFence, next.ControllerFence)
	}
	if _, err = svc.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: next.ControllerFence}); err != nil {
		t.Fatalf("B connection not usable: %v", err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:read'],scope_version=2 WHERE id=$1`, second.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: next.ControllerFence}); err == nil {
		t.Fatal("B connection survived producer scope removal")
	}
}
