package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type patScope struct{ dao *patDAO }

func (s patScope) IdentityDAO() store.IdentityDAO                 { return s.dao }
func (s patScope) CredentialFamilyDAO() store.CredentialFamilyDAO { panic("unexpected family") }
func (s patScope) PersonalTeamDAO() store.PersonalTeamDAO         { panic("unexpected personal") }

type patWriter struct {
	scope         patScope
	outcome       store.TransactionOutcome
	callback      error
	completionErr error
}

func (w *patWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	w.callback = fn(w.scope)
	if w.callback != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, w.callback
	}
	return store.Completion{Outcome: w.outcome}, w.completionErr
}

type patDAO struct {
	store.IdentityDAO
	calls     []string
	failFinal bool
	minted    model.PersonalAccessToken
}

func (d *patDAO) LockSession(context.Context, model.Principal, time.Time) error {
	d.calls = append(d.calls, "lock")
	if d.failFinal && len(d.calls) > 1 {
		return model.ErrNotFound
	}
	return nil
}
func (d *patDAO) CleanupCredentials(context.Context, time.Time) error {
	d.calls = append(d.calls, "cleanup")
	return nil
}
func (d *patDAO) InsertPAT(_ context.Context, p model.PersonalAccessToken) error {
	d.calls = append(d.calls, "insert")
	d.minted = p
	return nil
}
func (d *patDAO) FreshPATTime(_ context.Context, now time.Time) (time.Time, error) {
	d.calls = append(d.calls, "fresh")
	return now, nil
}
func (d *patDAO) ListAllPATs(context.Context, string) ([]model.PersonalAccessToken, error) {
	panic("unexpected list")
}
func (d *patDAO) ComparePATDescription(context.Context, string, string, *string, *string) (bool, error) {
	panic("unexpected update")
}
func (d *patDAO) PATExists(context.Context, string, string) (bool, error) {
	panic("unexpected existence check")
}

func TestCreatePATV2RequiresCommitAndRollsBackRefusal(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	for _, tc := range []struct {
		name               string
		outcome            store.TransactionOutcome
		failFinal, success bool
	}{
		{"committed", store.TransactionCommitted, false, true}, {"unknown", store.TransactionUnknown, false, false}, {"rejected", store.TransactionNotCommitted, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &patDAO{failFinal: tc.failFinal}
			w := &patWriter{scope: patScope{d}, outcome: tc.outcome}
			svc := New(w, nil, "")
			desc := " info "
			result, err := svc.CreatePATV2(t.Context(), p, p.UserID, core.CreatePAT{Name: "test"}, &desc)
			if tc.success {
				if err != nil || result.Secret == "" || d.minted.Description == nil || *d.minted.Description != "info" {
				t.Fatalf("minted result did not match the confirmed operation: %v", err)
				}
				return
			}
			if result.Secret != "" || err == nil {
				t.Fatal("unconfirmed secret escaped", err)
			}
			if tc.failFinal {
				var fault *model.Fault
				if !errors.As(w.callback, &fault) || fault.Code != "unauthenticated" {
					t.Fatal("refusal was not returned to transaction", w.callback)
				}
			} else {
				var transaction *store.TransactionError
				if !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown {
					t.Fatal("unknown outcome lost", err)
				}
			}
		})
	}
}
