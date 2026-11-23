package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

// The policy edit owns the credential lock before begin. Observing the waiting
// database query establishes the ordering without relying on a sleep.
func TestScopedBeginCommitsRevocationRefusal(t *testing.T) {
	f := newServiceFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	v := f.connectWeb(t, f.registerWeb(t))
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := f.service.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	actor := model.Principal{Kind: model.PATCredential, UserID: f.owner.UserID, CredentialID: uuid.NewString()}
	hash := sha256.Sum256([]byte(actor.CredentialID))
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,$3,'actor',now(),now()+interval '1 day',ARRAY['session:read','session:send'],1)`, actor.CredentialID, actor.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:read'],scope_version=1 WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	svc, err := NewScopedCommands(f.db, f.service.engine, TransactionCommandAuthorization{})
	if err != nil {
		t.Fatal(err)
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hi"}],"expectedTurnId":null}`)}
	if _, err = svc.Submit(ctx, actor, f.project, f.task, v.SessionID, command); err != nil {
		t.Fatal(err)
	}
	offers, err := svc.Poll(ctx, v.ControllerFence)
	if err != nil || len(offers) != 1 {
		t.Fatalf("offer: %v %v", offers, err)
	}
	tx, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:read'],scope_version=2 WHERE id=$1`, actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	type result struct {
		out map[string]any
		err error
	}
	finished := make(chan result, 1)
	pending := true
	defer func() {
		cancel()
		if pending {
			<-finished
		}
	}()
	go func() {
		out, err := svc.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID})
		finished <- result{out, err}
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := f.db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE '%personal_access_tokens%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case got := <-finished:
			pending = false
			t.Fatalf("begin completed before policy edit committed: %v %v", got.out, got.err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-finished:
		pending = false
		if got.err != nil || got.out["type"] != "receipt_ack" {
			t.Fatalf("begin: %v %v", got.out, got.err)
		}
		if receipt, ok := got.out["operation"].(sp.Operation); !ok || receipt.State != "rejected" {
			t.Fatalf("rejected receipt: %v", got.out)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	receipt, err := svc.Operation(ctx, f.owner, f.project, f.task, v.SessionID, command.OperationID)
	if err != nil || receipt.State != "rejected" {
		t.Fatalf("persisted receipt: %+v %v", receipt, err)
	}
	offers, err = svc.Poll(ctx, v.ControllerFence)
	if err != nil || len(offers) != 0 {
		t.Fatalf("revoked command reoffered: %v %v", offers, err)
	}
}
