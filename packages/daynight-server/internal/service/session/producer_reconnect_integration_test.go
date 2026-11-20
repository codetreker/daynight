package session

import (
	"context"
	"crypto/sha256"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestScopedTestSessionReconnectRechecksBothOriginalParents(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	second := f.owner
	second.CredentialID = uuid.NewString()
	h := sha256.Sum256([]byte(second.CredentialID))
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'reconnect',now(),now()+interval '1 day')`, second.CredentialID, second.UserID, h[:]); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{f.owner.CredentialID: true, second.CredentialID: true}
	source := func(_ context.Context, _ store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
		ids := []scopepolicy.ScopeID{"session:read"}
		if allowed[p.CredentialID] {
			ids = []scopepolicy.ScopeID{"session:produce"}
		}
		policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
		if err != nil {
			t.Fatal(err)
		}
		return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}, nil
	}
	service, err := NewScoped(f.db, f.service.engine, source)
	if err != nil {
		t.Fatal(err)
	}
	input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	v, err := service.RegisterTest(ctx, f.owner, input)
	if err != nil {
		t.Fatal(err)
	}
	grantInput := sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	grant, err := service.Grant(ctx, f.owner, "", "", v.SessionID, grantInput)
	if err != nil {
		t.Fatal(err)
	}
	sourceEpoch := uuid.NewString()
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, Provider: "codex", SourceEpoch: sourceEpoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	connected, err := service.Connect(ctx, grant.Token, hello, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	grantInput.Kind = "reconnect"
	reconnect, err := service.Grant(ctx, second, "", "", v.SessionID, grantInput)
	if err != nil {
		t.Fatal(err)
	}
	heartbeat := sp.ControllerMessage{Type: "heartbeat", ControllerFence: connected.ControllerFence}
	for _, id := range []string{f.owner.CredentialID, second.CredentialID} {
		allowed[id] = false
		if _, err = service.Handle(ctx, heartbeat); err == nil {
			t.Fatalf("old connection survived scope removal of %s", id)
		}
		if err = service.AuthenticateController(ctx, reconnect.Token); err == nil {
			t.Fatalf("grant survived scope removal of %s", id)
		}
		if _, err = service.Connect(ctx, reconnect.Token, hello, uuid.NewString()); err == nil {
			t.Fatalf("connect survived scope removal of %s", id)
		}
		allowed[id] = true
		if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if _, err = service.Handle(ctx, heartbeat); err == nil {
			t.Fatalf("old connection survived expiry of %s", id)
		}
		if _, err = service.Connect(ctx, reconnect.Token, hello, uuid.NewString()); err == nil {
			t.Fatalf("connect survived expiry of %s", id)
		}
		if _, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=now()+interval '1 day' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = service.Handle(ctx, heartbeat); err != nil {
		t.Fatal(err)
	}
	hello.ControllerFence = connected.ControllerFence
	next, err := service.Connect(ctx, reconnect.Token, hello, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if next.SessionID != connected.SessionID || next.ExecutionGeneration != connected.ExecutionGeneration || next.ConnectionEpoch == connected.ConnectionEpoch {
		t.Fatalf("wrong reconnect fence: old=%+v new=%+v", connected.ControllerFence, next.ControllerFence)
	}
	if _, err = service.Handle(ctx, heartbeat); err == nil {
		t.Fatal("old fence survived reconnect")
	}
	allowed[f.owner.CredentialID] = false
	if _, err = service.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: next.ControllerFence}); err != nil {
		t.Fatalf("old A affected new B connection: %v", err)
	}
	allowed[second.CredentialID] = false
	if _, err = service.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: next.ControllerFence}); err == nil {
		t.Fatal("new connection survived B scope removal")
	}
}
