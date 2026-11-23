package prompt

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
)

func TestScopedPromptReadsCurrentPolicyInsideOwningTransaction(t *testing.T) {
	m := mock(t)
	base := testService(m)
	incoming := promptAuthorization(t, "prompt:read", "prompt:write")
	restricted := promptAuthorization(t, "task:read")
	calls := 0
	svc, err := NewScoped(base.store, func(_ context.Context, tx any, p model.Principal, write bool) (model.CredentialAuthorization, error) {
		calls++
		if p != incoming.Principal {
			t.Fatal("wrong actor")
		}
		if write {
			if _, ok := tx.(store.PromptWriteScope); !ok {
				t.Fatal("write outside owning tx")
			}
		} else {
			if _, ok := tx.(store.PromptSnapshot); !ok {
				t.Fatal("read outside owning snapshot")
			}
		}
		return restricted, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	m.snapshot()
	_, err = svc.GetAuthorized(t.Context(), incoming, model.PromptScopeUser, user)
	fault(t, err, "insufficient_scope")
	m.writeFailure(store.TransactionNotCommitted, "operation", nil)
	_, err = svc.PutAuthorized(t.Context(), incoming, model.PromptScopeUser, user, user, "0", "new")
	fault(t, err, "insufficient_scope")
	if calls != 2 {
		t.Fatalf("policy calls %d", calls)
	}
	if _, err := NewScoped(nil, nil); err == nil {
		t.Fatal("missing current policy accepted")
	}
	sentinel := errors.New("policy unavailable")
	svc.current = func(context.Context, any, model.Principal, bool) (model.CredentialAuthorization, error) {
		return model.CredentialAuthorization{}, sentinel
	}
	if err := svc.admit(t.Context(), nil, incoming, false); !errors.Is(err, sentinel) {
		t.Fatalf("read error %v", err)
	}
	svc.current = func(context.Context, any, model.Principal, bool) (model.CredentialAuthorization, error) {
		a := incoming
		a.Profile = model.SessionProfile
		return a, nil
	}
	if err := svc.admit(t.Context(), nil, incoming, false); err == nil {
		t.Fatal("changed profile accepted")
	}
	svc.current = func(context.Context, any, model.Principal, bool) (model.CredentialAuthorization, error) {
		return incoming, nil
	}
	if err := svc.admit(t.Context(), nil, incoming, true, scopepolicy.PromptWrite); err != nil {
		t.Fatal(err)
	}
}
