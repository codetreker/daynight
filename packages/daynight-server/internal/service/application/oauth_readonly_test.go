package application

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

type readonlyAssemblyStore struct {
	*borrowedStore
	principal model.Principal
	resource  string
	failure   error
	calls     int
}

func (s *readonlyAssemblyStore) WriteIdentity(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
	s.t.Error("OAuth readonly callback entered native identity transaction")
	return store.Completion{}, errors.New("unexpected native identity transaction")
}

func (s *readonlyAssemblyStore) WriteCredentialFamily(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
	s.calls++
	err := fn(readonlyAssemblyScope{s})
	if err != s.failure {
		s.t.Fatalf("family callback replaced error: %v", err)
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, err
}

type readonlyAssemblyScope struct{ *readonlyAssemblyStore }

func (s readonlyAssemblyScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	return readonlyAssemblyDAO{readonlyAssemblyStore: s.readonlyAssemblyStore}
}

type readonlyAssemblyDAO struct {
	store.CredentialFamilyDAO
	*readonlyAssemblyStore
}

func (d readonlyAssemblyDAO) LockAccess(ctx context.Context, principal model.Principal, bindings []store.OAuthBinding, now time.Time) error {
	want := []store.OAuthBinding{{Resource: d.resource, Scope: oauth.APIScope, ClientID: oauth.APIClientID}}
	if principal != d.principal || !reflect.DeepEqual(bindings, want) || now.IsZero() || ctx.Err() != nil {
		d.t.Fatalf("assembled OAuth callback changed access facts: %+v %+v %v %v", principal, bindings, now, ctx.Err())
	}
	return d.failure
}

func TestApplicationReadOnlyUsesItsSharedOAuthAuthenticator(t *testing.T) {
	borrowed, files := borrowedDependencies(t)
	db := &readonlyAssemblyStore{borrowedStore: borrowed, principal: model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.OAuthCredential}, failure: errors.New("family read failed")}
	app := New(db, files, nil, "", time.Second)
	t.Cleanup(app.WorkerReadOnly.Close)
	verifySharedEngine(t, app)
	for _, origin := range []string{"https://daynight.test", "https://other.daynight.test"} {
		app.OAuth.SetOrigin(origin)
		db.resource = origin + "/api/v1"
		_, err := app.WorkerReadOnly.Request(t.Context(), db.principal, uuid.NewString(), workerreadonly.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)})
		if !errors.Is(err, db.failure) {
			t.Fatalf("readonly lost shared OAuth error: %v", err)
		}
	}
	if db.calls != 2 {
		t.Fatalf("family callback calls = %d, want 2", db.calls)
	}
}
