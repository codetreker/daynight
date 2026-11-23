package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestCombinedScopedConstructorRequiresBothSources(t *testing.T) {
	engine := core.NewEngine(nil)
	t.Cleanup(func() { stopHistoryEngine(t, engine) })
	cmd := commandSourceFunc(func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error) {
		return model.CredentialAuthorization{}, errors.New("unavailable")
	})
	prod := ProducerAuthorization(func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error) {
		return model.CredentialAuthorization{}, errors.New("unavailable")
	})
	for _, tc := range []struct {
		name     string
		command  CommandAuthorizationSource
		producer ProducerAuthorization
	}{{"missing command", nil, prod}, {"missing producer", cmd, nil}} {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := NewScopedCommandsAndProducer(nil, engine, tc.command, tc.producer); err == nil || got != nil {
				t.Fatalf("missing dependency accepted: %v", err)
			}
		})
	}
	svc, err := NewScopedCommandsAndProducer(nil, engine, cmd, prod)
	if err != nil {
		t.Fatal(err)
	}
	if svc.ScopedCommandExecution() != svc.Execution {
		t.Fatal("scoped command execution not retained")
	}
	if err = svc.Execution.SetCommandAdmission(func(context.Context, store.SessionScope, model.Principal, scopepolicy.Operation) error { return nil }); err == nil {
		t.Fatal("command policy replaced")
	}
}

func TestCombinedScopedExecutionRechecksProducerAndCommandIndependently(t *testing.T) {
	f := newServiceFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	v := f.connectWeb(t, f.registerWeb(t))
	synchronizeServiceSession(t, f, v)
	actor := model.Principal{Kind: model.PATCredential, UserID: f.owner.UserID, CredentialID: uuid.NewString()}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:produce'],scope_version=1 WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(actor.CredentialID))
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,$3,'command actor',now(),now()+interval '1 day',ARRAY['session:send'],1)`, actor.CredentialID, actor.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	source := TransactionCommandAuthorization{Origin: "https://daynight.example"}
	svc, err := NewScopedCommandsAndProducer(f.db, f.service.engine, source, source.SessionWrite)
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
	if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:read'],scope_version=2 WHERE id=$1`, actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	result, err := svc.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID})
	if err != nil {
		t.Fatal(err)
	}
	receipt, ok := result["operation"].(sp.Operation)
	if !ok || result["type"] != "receipt_ack" || receipt.State != "rejected" {
		t.Fatalf("command revocation: %v", result)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:read'],scope_version=2 WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Poll(ctx, v.ControllerFence); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("producer revocation: %v", err)
	}
}
