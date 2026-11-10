package oauth

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type authenticationDAO struct {
	store.CredentialFamilyDAO
	identity store.OAuthAccessIdentity
	err      error
	ctx      context.Context
	hash     []byte
	resource string
	scope    string
	now      time.Time
	calls    int
}

func (d *authenticationDAO) AuthenticateAccess(ctx context.Context, hash []byte, resource, scope string, now time.Time) (store.OAuthAccessIdentity, error) {
	d.ctx, d.hash, d.resource, d.scope, d.now = ctx, hash, resource, scope, now
	d.calls++
	return d.identity, d.err
}

type authenticationWriter struct {
	dao        *authenticationDAO
	completion store.Completion
	err        error
	ctx        context.Context
	calls      int
}

func (w *authenticationWriter) CredentialFamilyDAO() store.CredentialFamilyDAO { return w.dao }

func (w *authenticationWriter) WriteCredentialFamily(ctx context.Context, operation func(store.CredentialFamilyScope) error) (store.Completion, error) {
	w.ctx = ctx
	w.calls++
	if w.err != nil {
		return w.completion, w.err
	}
	if err := operation(w); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return w.completion, nil
}

func accessIdentity() store.OAuthAccessIdentity {
	return store.OAuthAccessIdentity{
		GrantID: uuid.NewString(),
		Principal: model.Principal{
			Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString(),
		},
	}
}

func TestAuthenticatorReturnsIdentityAfterConfirmedCommit(t *testing.T) {
	identity := accessIdentity()
	dao := &authenticationDAO{identity: identity}
	writer := &authenticationWriter{dao: dao, completion: store.Completion{Outcome: store.TransactionCommitted}}
	authenticator := NewAuthenticator(writer)
	token := secret.Random(model.OAuthAccessPrefix)
	resource := "https://daynight.example/mcp"
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	before := time.Now().UTC().Truncate(time.Microsecond)
	got, err := authenticator.AuthenticateAccess(ctx, token, resource)
	after := time.Now().UTC()
	if err != nil || got != identity {
		t.Fatalf("AuthenticateAccess() = %+v, %v; want %+v", got, err, identity)
	}
	if writer.calls != 1 || writer.ctx != ctx || dao.calls != 1 || dao.ctx != ctx {
		t.Fatalf("transaction calls=%d, DAO calls=%d; context must reach the transaction-bound DAO", writer.calls, dao.calls)
	}
	if !bytes.Equal(dao.hash, secret.Hash(token)) || dao.resource != resource || dao.scope != core.Scope {
		t.Fatalf("DAO received hash=%x resource=%q scope=%q", dao.hash, dao.resource, dao.scope)
	}
	if dao.now.Before(before) || dao.now.After(after) || dao.now.Location() != time.UTC || dao.now.Nanosecond()%1000 != 0 {
		t.Fatalf("authentication time %v outside [%v, %v] or not UTC microsecond precision", dao.now, before, after)
	}
}

func TestAuthenticatorPropagatesTransactionAndDAOFailures(t *testing.T) {
	for _, phase := range []string{"transaction", "DAO"} {
		t.Run(phase, func(t *testing.T) {
			failure := errors.New("authentication storage failed")
			dao := &authenticationDAO{identity: accessIdentity()}
			writer := &authenticationWriter{dao: dao, completion: store.Completion{Outcome: store.TransactionCommitted}}
			wantDAOCalls := 1
			if phase == "transaction" {
				writer.err = failure
				wantDAOCalls = 0
			} else {
				dao.err = failure
			}
			got, err := NewAuthenticator(writer).AuthenticateAccess(t.Context(), secret.Random(model.OAuthAccessPrefix), "https://daynight.example/mcp")
			if err != failure || got != (store.OAuthAccessIdentity{}) {
				t.Fatalf("AuthenticateAccess() = %+v, %v; want empty identity and original error", got, err)
			}
			if writer.calls != 1 || dao.calls != wantDAOCalls {
				t.Fatalf("transaction calls=%d, DAO calls=%d; want 1, %d", writer.calls, dao.calls, wantDAOCalls)
			}
		})
	}
}

func TestAuthenticatorSuppressesIdentityWithoutConfirmedCommit(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown, ""} {
		t.Run(string(outcome), func(t *testing.T) {
			dao := &authenticationDAO{identity: accessIdentity()}
			writer := &authenticationWriter{dao: dao, completion: store.Completion{Outcome: outcome}}
			got, err := NewAuthenticator(writer).AuthenticateAccess(t.Context(), secret.Random(model.OAuthAccessPrefix), "https://daynight.example/mcp")
			if err == nil || !strings.Contains(err.Error(), "did not confirm commit") || got != (store.OAuthAccessIdentity{}) || dao.calls != 1 {
				t.Fatalf("unconfirmed authentication = %+v, %v, DAO calls=%d", got, err, dao.calls)
			}
		})
	}
}

func TestAuthenticatorRejectsMalformedTokenBeforeDAOAccess(t *testing.T) {
	dao := &authenticationDAO{identity: accessIdentity()}
	writer := &authenticationWriter{dao: dao, completion: store.Completion{Outcome: store.TransactionCommitted}}
	got, err := NewAuthenticator(writer).AuthenticateAccess(t.Context(), "not-an-access-token", "https://daynight.example/mcp")
	if err == nil || got != (store.OAuthAccessIdentity{}) || dao.calls != 0 || writer.calls != 1 {
		t.Fatalf("malformed authentication = %+v, %v, transaction calls=%d, DAO calls=%d", got, err, writer.calls, dao.calls)
	}
}
