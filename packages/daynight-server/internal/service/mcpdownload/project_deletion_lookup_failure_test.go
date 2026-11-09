package mcpdownload

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

type failedLookupWriter struct {
	db              *postgres.Store
	failAt, lookups int
}

func (w *failedLookupWriter) WritePrivateTransfer(ctx context.Context, op func(store.PrivateTransferDAO) error) (store.Completion, error) {
	return w.db.WritePrivateTransfer(ctx, func(dao store.PrivateTransferDAO) error {
		return op(failedLookupDAO{PrivateTransferDAO: dao, owner: w})
	})
}

type failedLookupDAO struct {
	store.PrivateTransferDAO
	owner *failedLookupWriter
}

func (d failedLookupDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	result, err := d.PrivateTransferDAO.Get(ctx, id)
	d.owner.lookups++
	if d.owner.lookups != d.owner.failAt || !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	// Kill the real connection after its missing-row observation but before
	// rollback, forcing the transaction executor to report failed cleanup.
	var killed bool
	killErr := d.owner.db.Pool.QueryRow(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%FROM private_transfers WHERE id=%FOR UPDATE%' AND pid<>pg_backend_pid() ORDER BY pid LIMIT 1`).Scan(&killed)
	if killErr != nil || !killed {
		return result, fmt.Errorf("terminate lookup backend: killed=%t: %w", killed, killErr)
	}
	return result, err
}

func TestOpenDoesNotHideMissingLookupCleanupFailure(t *testing.T) {
	for _, step := range []struct {
		name   string
		lookup int
	}{{"initial lookup", 1}, {"source recheck", 2}} {
		t.Run(step.name, func(t *testing.T) {
			f := newAcceptanceFixture(t)
			writer := &failedLookupWriter{db: f.db, failAt: step.lookup}
			lifecycle, err := mcptransfer.New(writer, f.files, f.files, 1<<30, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer lifecycle.Close(context.Background())
			svc := New(f.attachments, lifecycle, f.files)
			in := f.input
			in.Action = "open"
			in.Path = "absent.txt"
			in.TransferID = uuid.NewString()
			result, err := svc.Read(t.Context(), f.actor, in)
			var transaction *store.TransactionError
			if result != nil || !errors.As(err, &transaction) || !transaction.CleanupFailed || transaction.Outcome != store.TransactionUnknown || !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("missing cleanup failure lost: data=%#v error=%v", result, err)
			}
			if fault, known := operation.KnownFault(err); known {
				t.Fatalf("unconfirmed transaction classified as refusal: %+v", fault)
			}
			if writer.lookups != step.lookup {
				t.Fatalf("lookups=%d want %d", writer.lookups, step.lookup)
			}
		})
	}
}

type failedSourceThenDelete struct {
	db        *postgres.Store
	actor     model.Principal
	sourceErr error
}

func (s *failedSourceThenDelete) OpenBounded(ctx context.Context, p model.Principal, project, task, path string, _ int) (model.Attachment, filestorage.Object, error) {
	s.sourceErr = s.db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := snapshot.ProjectDAO().ProjectAccess(ctx, p, project); err != nil {
			return err
		}
		var killed bool
		err := s.db.Pool.QueryRow(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%FROM projects p LEFT JOIN project_ownership%' AND pid<>pg_backend_pid() ORDER BY pid LIMIT 1`).Scan(&killed)
		if err != nil || !killed {
			return fmt.Errorf("terminate source backend: killed=%t: %w", killed, err)
		}
		return errors.New("source observation failed")
	})
	var failure *store.TransactionError
	if !errors.As(s.sourceErr, &failure) || !failure.CleanupFailed {
		return model.Attachment{}, filestorage.Object{}, fmt.Errorf("source cleanup failure missing: %w", s.sourceErr)
	}
	receipt, err := projectservice.NewProjects(s.db).Delete(ctx, s.actor, project)
	if err != nil || !receipt.Deleted {
		return model.Attachment{}, filestorage.Object{}, fmt.Errorf("delete during source failure: %w", err)
	}
	return model.Attachment{}, filestorage.Object{}, s.sourceErr
}

func TestOpenPreservesSourceCleanupFailureAcrossProjectDeletion(t *testing.T) {
	f := newAcceptanceFixture(t)
	opener := &failedSourceThenDelete{db: f.db, actor: f.actor.Principal}
	svc := New(opener, f.lifecycle, f.files)
	in := f.input
	in.Action = "open"
	in.Path = "absent.txt"
	in.TransferID = uuid.NewString()
	result, err := svc.Read(t.Context(), f.actor, in)
	var failure *store.TransactionError
	if result != nil || !errors.As(err, &failure) || !failure.CleanupFailed || failure.Outcome != store.TransactionUnknown || !errors.Is(err, opener.sourceErr) {
		t.Fatalf("source cleanup failure lost after deletion: data=%#v error=%v original=%v", result, err, opener.sourceErr)
	}
}
