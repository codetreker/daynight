package mcptransfer

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type deletedAuthorizationDAO struct{ store.PrivateTransferDAO }

func (deletedAuthorizationDAO) Authorize(context.Context, model.Principal, string, string, string, string) error {
	return model.ErrNotFound
}

type deletedAuthorizationWriter struct {
	phase   string
	outcome store.TransactionOutcome
	cleanup bool
}

func (w deletedAuthorizationWriter) WritePrivateTransfer(_ context.Context, op func(store.PrivateTransferDAO) error) (store.Completion, error) {
	cause := op(deletedAuthorizationDAO{})
	return store.Completion{Outcome: w.outcome}, &store.TransactionError{Phase: w.phase, Outcome: w.outcome, CleanupFailed: w.cleanup, Cause: cause}
}

func TestDeletedProjectAuthorizationCompletionPrecedence(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	user, credential := uuid.NewString(), uuid.NewString()
	actor := Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: credential}, AuthorityKind: "pat", AuthorityID: credential}
	for _, test := range []struct {
		name, phase    string
		outcome        store.TransactionOutcome
		cleanup, known bool
	}{
		{"confirmed rollback", "operation", store.TransactionNotCommitted, false, true},
		{"unknown commit", "commit", store.TransactionUnknown, false, false},
		{"cleanup failure", "cleanup", store.TransactionUnknown, true, false},
		{"cleanup failure with rollback fact", "cleanup", store.TransactionNotCommitted, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			lifecycle, err := New(deletedAuthorizationWriter{phase: test.phase, outcome: test.outcome, cleanup: test.cleanup}, files, files, 1<<20, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer lifecycle.Close(context.Background())
			err = lifecycle.Authorize(context.Background(), actor, uuid.NewString(), uuid.NewString())
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("missing original cause: %v", err)
			}
			fault, known := operation.KnownFault(err)
			if known != test.known || known && fault.Code != "not_found" {
				t.Fatalf("classification: %#v %t %v", fault, known, err)
			}
		})
	}
}
