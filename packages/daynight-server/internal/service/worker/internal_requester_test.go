package worker

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
)

func TestInternalReadOnlyRequesterRejectsIncompleteAuthority(t *testing.T) {
	b := ro.New(func(context.Context, model.Principal, string) error {
		t.Fatal("internal requester entered public inspection")
		return nil
	})
	defer b.Close()
	current := func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		t.Fatal("invalid request read credential")
		return model.CredentialAuthorization{}, nil
	}
	db := forbiddenWorkerStore{t: t}
	for _, missingBroker := range []bool{false, true} {
		broker, reader := b, current
		if missingBroker {
			broker = nil
		} else {
			reader = nil
		}
		if got, err := NewScopedReadOnlyRequester(db, broker, reader); got != nil || err == nil {
			t.Fatalf("missing dependency accepted: %v %v", got, err)
		}
	}
	requester, err := NewScopedReadOnlyRequester(db, b, current)
	if err != nil {
		t.Fatal(err)
	}
	p := workerRefusalPrincipal()
	for _, operations := range [][]scopepolicy.Operation{nil, {scopepolicy.Operation("unknown")}} {
		if got, err := requester.RequestForOperations(t.Context(), p, refusalWorkerID, readOnlyRequest(), operations...); err == nil || got.Type != "" {
			t.Fatalf("invalid operation plan accepted: %+v %v", got, err)
		}
	}
	if _, err := requester.RequestForOperations(t.Context(), model.Principal{}, refusalWorkerID, readOnlyRequest(), scopepolicy.BotWrite); err == nil {
		t.Fatal("invalid principal admitted")
	}
	failure := errors.New("current credential unavailable")
	requester.current = func(_ context.Context, got model.Principal) (model.CredentialAuthorization, error) {
		if got != p {
			t.Fatalf("principal changed: %+v", got)
		}
		return model.CredentialAuthorization{}, failure
	}
	if _, err := requester.RequestForOperations(t.Context(), p, refusalWorkerID, readOnlyRequest(), scopepolicy.BotWrite); !errors.Is(err, failure) {
		t.Fatalf("credential failure lost: %v", err)
	}
	requester.current = func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		other := p
		other.CredentialID = "33333333-3333-4333-8333-333333333333"
		return model.CredentialAuthorization{Principal: other}, nil
	}
	if _, err := requester.RequestForOperations(t.Context(), p, refusalWorkerID, readOnlyRequest(), scopepolicy.BotWrite); err == nil {
		t.Fatal("substituted principal admitted")
	}
}
