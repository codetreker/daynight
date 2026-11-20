package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type commandSourceFunc func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error)

func (f commandSourceFunc) SessionWrite(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
	return f(ctx, scope, p)
}

func TestCommandAuthorizationUsesTransactionActorAndCurrentPolicy(t *testing.T) {
	ctx := context.WithValue(t.Context(), struct{}{}, "transaction")
	scope := &receiptScope{}
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:send"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("credential read failed")
	for _, tc := range []struct {
		name      string
		auth      model.CredentialAuthorization
		sourceErr error
		operation scopepolicy.Operation
		wantCode  string
		wantErr   bool
	}{
		{"send", model.CredentialAuthorization{Principal: actor, Profile: model.ScopedPATProfile, Policy: &policy}, nil, scopepolicy.SessionSend, "", false},
		{"read denied", model.CredentialAuthorization{Principal: actor, Profile: model.ScopedPATProfile, Policy: &policy}, nil, scopepolicy.SessionRead, "insufficient_scope", true},
		{"missing policy", model.CredentialAuthorization{Principal: actor, Profile: model.ScopedPATProfile}, nil, scopepolicy.SessionSend, "", true},
		{"identity changed", model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}, Profile: model.ScopedPATProfile, Policy: &policy}, nil, scopepolicy.SessionSend, "", true},
		{"source failed", model.CredentialAuthorization{}, cause, scopepolicy.SessionSend, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := 0
			source := commandSourceFunc(func(gotCtx context.Context, gotScope store.SessionScope, got model.Principal) (model.CredentialAuthorization, error) {
				called++
				if gotCtx != ctx || gotScope != scope || got != actor {
					t.Fatal("transaction or actor changed")
				}
				return tc.auth, tc.sourceErr
			})
			err := requireCommandAuthorization(ctx, source, scope, actor, tc.operation)
			if called != 1 || (err != nil) != tc.wantErr {
				t.Fatalf("calls %d, error %v", called, err)
			}
			if tc.sourceErr != nil && !errors.Is(err, cause) {
				t.Fatalf("lost cause: %v", err)
			}
			if tc.wantCode != "" {
				requireServiceError(t, err, tc.wantCode)
			}
		})
	}
	if _, err := NewScopedCommands(nil, nil, nil); err == nil {
		t.Fatal("missing source accepted")
	}
}

func TestTransactionCommandAuthorizationRequiresCredentialCapability(t *testing.T) {
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	_, err := (TransactionCommandAuthorization{}).SessionWrite(t.Context(), &receiptScope{}, actor)
	if err == nil {
		t.Fatal("missing transaction credential capability accepted")
	}
	browser := model.Principal{Kind: model.SessionCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}
	auth, err := (TransactionCommandAuthorization{}).SessionWrite(t.Context(), &receiptScope{}, browser)
	if err != nil || auth.Principal != browser || auth.Profile != model.SessionProfile || auth.Validate() != nil {
		t.Fatalf("browser profile: %+v %v", auth, err)
	}
}
