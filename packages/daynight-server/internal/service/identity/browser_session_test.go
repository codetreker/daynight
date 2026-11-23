package identity

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type activityWriter struct {
	scope       store.IdentityScope
	completion  store.Completion
	err         error
	callbackErr error
	calls       int
}

func (w *activityWriter) WriteIdentity(ctx context.Context, operation func(store.IdentityScope) error) (store.Completion, error) {
	w.calls++
	w.callbackErr = operation(w.scope)
	if w.callbackErr != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, w.callbackErr
	}
	return w.completion, w.err
}

func TestBrowserActivityExposesPrincipalOnlyAfterConfirmedCommit(t *testing.T) {
	cause := errors.New("commit failed")
	principal := model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"}
	for _, kind := range []string{"committed", "refused", "not-committed", "unknown", "commit-error"} {
		t.Run(kind, func(t *testing.T) {
			dao := &identityCapability{}
			scope := &identityScope{identity: dao}
			writer := &activityWriter{scope: scope, completion: store.Completion{Outcome: store.TransactionCommitted}}
			var rejection error
			switch kind {
			case "refused":
				rejection = &model.Fault{Code: "identity_mismatch", Cause: cause}
			case "not-committed":
				writer.completion.Outcome = store.TransactionNotCommitted
			case "unknown":
				writer.completion.Outcome = store.TransactionUnknown
				writer.err = cause
			case "commit-error":
				writer.err = cause
			}
			calls := 0
			s := New(writer, nil, "https://daynight.cc/auth/callback")
			s.ops.authenticateBrowserActivity = func(ctx context.Context, bound store.IdentityDAO, value, expected string) (model.Principal, error) {
				calls++
				if ctx != t.Context() || bound != dao || value != "secret" || expected != "user" {
					t.Fatal("activity binding changed")
				}
				return principal, rejection
			}
			got, err := s.AuthenticateBrowserActivity(t.Context(), "secret", "user")
			if calls != 1 || writer.calls != 1 {
				t.Fatal("activity replayed or did not execute")
			}
			if kind == "committed" {
				if err != nil || got != principal {
					t.Fatalf("committed %+v %v", got, err)
				}
			} else {
				if err == nil || got != (model.Principal{}) {
					t.Fatalf("unconfirmed principal exposed %+v %v", got, err)
				}
				if kind == "refused" && !errors.Is(err, rejection) {
					t.Fatal("refusal chain lost")
				}
				if kind == "unknown" {
					var transaction *store.TransactionError
					if !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown || !errors.Is(err, cause) {
						t.Fatalf("unknown lost: %v", err)
					}
				}
			}
		})
	}
}

func TestPreviewActivityCommitsOnceAndPreservesRefusal(t *testing.T) {
	for _, kind := range []string{"committed", "refused", "unknown", "not-committed"} {
		t.Run(kind, func(t *testing.T) {
			ctx := t.Context()
			dao := &previewDAO{}
			fault := &model.Fault{Code: "unauthenticated"}
			w := &previewWriter{t: t, ctx: ctx, dao: dao, completion: store.Completion{Outcome: store.TransactionCommitted}}
			op := &previewOps{t: t, ctx: ctx, dao: dao, want: "renew"}
			s := &PreviewSSO{writer: w, ops: op}
			switch kind {
			case "refused":
				op.failure = fault
				w.callbackError = fault
				w.err = fault
			case "unknown":
				w.completion.Outcome = store.TransactionUnknown
			case "not-committed":
				w.completion.Outcome = store.TransactionNotCommitted
			}
			err := s.Renew(ctx, "secret", model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"})
			if w.calls != 1 || op.calls != 1 {
				t.Fatal("preview renewal replayed")
			}
			if kind == "committed" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("unconfirmed preview renewal succeeded")
			}
			if kind == "refused" && !errors.Is(err, fault) {
				t.Fatal("refusal lost")
			}
		})
	}
}
