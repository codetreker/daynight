package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type revokeCompletionDAO struct {
	store.IdentityDAO
	store.BrowserSessionManagementDAO
	t         *testing.T
	ctx       context.Context
	user      string
	rows      map[string]model.Session
	calls     []string
	deleteErr error
}

func (d *revokeCompletionDAO) LockBrowserSessionID(ctx context.Context, user, id string) (model.Session, error) {
	if ctx != d.ctx || user != d.user {
		d.t.Fatal("lost transaction context or account")
	}
	d.calls = append(d.calls, "lock:"+id)
	return d.rows[id], nil
}
func (d *revokeCompletionDAO) SessionTime(ctx context.Context) (time.Time, error) {
	if ctx != d.ctx {
		d.t.Fatal("lost clock context")
	}
	d.calls = append(d.calls, "clock")
	return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), nil
}
func (d *revokeCompletionDAO) DeleteBrowserSessionID(ctx context.Context, user, id string) error {
	if ctx != d.ctx || user != d.user {
		d.t.Fatal("lost deletion context or account")
	}
	d.calls = append(d.calls, "delete:"+id)
	return d.deleteErr
}

func TestRevokeBrowserSessionRequiresConfirmedTransaction(t *testing.T) {
	const user = "11111111-1111-4111-8111-111111111111"
	const caller = "22222222-2222-4222-8222-222222222222"
	const target = "33333333-3333-4333-8333-333333333333"
	cause := errors.New("transaction failure")
	for _, kind := range []string{"committed", "unknown", "not_committed", "operation_error", "commit_error"} {
		t.Run(kind, func(t *testing.T) {
			expires := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
			dao := &revokeCompletionDAO{t: t, ctx: t.Context(), user: user, rows: map[string]model.Session{caller: {ID: caller, UserID: user, ExpiresAt: expires}, target: {ID: target, UserID: user, ExpiresAt: expires}}}
			writer := &activityWriter{scope: arbitraryIdentityScope{dao: dao}, completion: store.Completion{Outcome: store.TransactionCommitted}}
			switch kind {
			case "unknown":
				writer.completion.Outcome = store.TransactionUnknown
				writer.err = cause
			case "not_committed":
				writer.completion.Outcome = store.TransactionNotCommitted
			case "operation_error":
				dao.deleteErr = cause
			case "commit_error":
				writer.err = cause
			}
			principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: caller}
			err := New(writer, nil, "").RevokeBrowserSession(t.Context(), principal, target, user, caller)
			expected := []string{"lock:" + caller, "lock:" + target, "clock", "delete:" + target}
			if writer.calls != 1 || !reflect.DeepEqual(dao.calls, expected) {
				t.Fatalf("replayed or changed operation: transactions=%d calls=%v", writer.calls, dao.calls)
			}
			if kind == "committed" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("unconfirmed transaction reported success")
			}
			if kind == "unknown" {
				var tx *store.TransactionError
				if !errors.As(err, &tx) || tx.Outcome != store.TransactionUnknown || !errors.Is(err, cause) {
					t.Fatalf("unknown completion lost: %v", err)
				}
			}
			if (kind == "operation_error" || kind == "commit_error") && !errors.Is(err, cause) {
				t.Fatalf("cause lost: %v", err)
			}
			if kind == "operation_error" && writer.callbackErr != cause {
				t.Fatalf("operation was not rolled back: %v", writer.callbackErr)
			}
		})
	}
}
