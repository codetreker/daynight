package attachment

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func transferNamespace(t *testing.T) filestorage.TransferNamespace {
	t.Helper()
	n, err := filestorage.NewTransferNamespace(uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPutTransferAdmissionSurvivesRevocationAndBlocksDeletion(t *testing.T) {
	attachments, tasks, database, files, task, owner := attachmentService(t)
	member := testsupport.ServicePrincipal(t, database)
	memberships := projectservice.NewMemberships(database)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	invitation, err := memberships.CreateInvitation(ctx, owner, task.ProjectID, owner.UserID)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := memberships.AcceptInvitation(ctx, member, invitation.Secret, member.UserID)
	if err != nil {
		t.Fatal(err)
	}
	namespace := transferNamespace(t)
	permit, err := files.AcquireGate(ctx, filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	admission, err := attachments.AdmitTransfer(ctx, member, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	reader := &pausedAttachmentReader{Reader: strings.NewReader("complete"), ctx: ctx, reached: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	unblock := func() { release.Do(func() { close(reader.release) }) }
	defer func() {
		unblock()
		cancel()
		_ = admission.Close()
	}()
	type result struct {
		item    model.Attachment
		created bool
		err     error
	}
	finished := make(chan result, 1)
	go func() {
		item, created, err := admission.Put(ctx, reader)
		finished <- result{item, created, err}
	}()
	select {
	case <-reader.reached:
	case got := <-finished:
		t.Fatalf("stream did not start: %v", got.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, err = memberships.RemoveGrant(ctx, owner, task.ProjectID, member.UserID, coreproject.RemoveProjectMember{Version: joined.DirectGrant.Version, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatalf("revoke during stream: %v", err)
	}
	var blocker int32
	if err := database.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%task_attachments%' LIMIT 1),0)`).Scan(&blocker); err != nil || blocker == 0 {
		t.Fatalf("upload transaction: %d %v", blocker, err)
	}
	deleted := make(chan error, 1)
	go func() {
		deleted <- tasks.Delete(ctx, owner, task.ProjectID, task.ID, taskcore.DeleteTask{Version: task.Version})
	}()
	waitAttachmentBlocked(t, ctx, database, blocker)
	blocked, stop := context.WithTimeout(ctx, 100*time.Millisecond)
	_, _, err = attachments.Open(blocked, owner, task.ProjectID, task.ID, "file")
	stop()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("target gate did not protect admitted stream: %v", err)
	}
	unblock()
	select {
	case got := <-finished:
		if got.err != nil || !got.created || got.item.SizeBytes != int64(len("complete")) {
			t.Fatalf("admitted result: %#v", got)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := attachmentWaitResult(t, ctx, deleted); err != nil {
		t.Fatalf("delete after stream: %v", err)
	}
	if _, _, err := admission.Put(ctx, strings.NewReader("again")); err == nil {
		t.Fatal("admission accepted a second publication")
	}
	if err := admission.Close(); err != nil {
		t.Fatal(err)
	}
	assertAttachmentState(t, ctx, database, files, task, true, "complete")
	_, _, err = attachments.Open(ctx, owner, task.ProjectID, task.ID, "file")
	requireFault(t, err, "task_deleted")
	_, err = attachments.AdmitTransfer(ctx, owner, task.ProjectID, task.ID, "other", "text/plain", namespace)
	requireFault(t, err, "task_deleted")
	if err := files.DeleteTransferNamespace(ctx, namespace); err != nil {
		t.Fatal(err)
	}
	assertAttachmentState(t, ctx, database, files, task, true, "complete")
}

func TestPutTransferReportsFileEffectAfterMetadataFailure(t *testing.T) {
	attachments, _, database, files, task, principal := attachmentService(t)
	putAttachment(t, attachments, principal, task, "file", "before")
	if _, err := database.Pool.Exec(t.Context(), `CREATE FUNCTION refuse_transfer_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'metadata refused'; END $$;
		CREATE TRIGGER refuse_transfer_metadata BEFORE INSERT OR UPDATE ON task_attachments FOR EACH ROW EXECUTE FUNCTION refuse_transfer_metadata()`); err != nil {
		t.Fatal(err)
	}
	namespace := transferNamespace(t)
	permit, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	admission, err := attachments.AdmitTransfer(t.Context(), principal, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer admission.Close()
	_, _, err = admission.Put(t.Context(), strings.NewReader("after"))
	if err == nil || !FileEffectPossible(err) {
		t.Fatalf("missing file effect: %v", err)
	}
	object, err := files.Open(t.Context(), "task-attachments", attachmentTestStoragePath(task, "file"))
	if err != nil {
		t.Fatal(err)
	}
	defer object.Body.Close()
	var stored [5]byte
	if _, err := object.Body.Read(stored[:]); err != nil || string(stored[:]) != "after" {
		t.Fatalf("published content: %q %v", stored, err)
	}
}

type failingTransferPublisher struct {
	*local.Storage
	cause        error
	publishFirst bool
	objectID     string
}

func (s *failingTransferPublisher) PublishTransferAttachment(ctx context.Context, namespace filestorage.TransferNamespace, objectID string, target filestorage.TransferAttachmentTarget) error {
	s.objectID = objectID
	if s.publishFirst {
		if err := s.Storage.PublishTransferAttachment(ctx, namespace, objectID, target); err != nil {
			return err
		}
	}
	return s.cause
}

func TestPutTransferPublicationFailuresPreserveTransactionFacts(t *testing.T) {
	for _, test := range []struct {
		name         string
		cause        error
		publishFirst bool
	}{
		{name: "path conflict", cause: filestorage.ErrPathConflict},
		{name: "failure after publication", cause: errors.New("publication sync failed"), publishFirst: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			attachments, tasks, database, files, task, principal := attachmentService(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			before := putAttachment(t, attachments, principal, task, "file", "before")
			publisher := &failingTransferPublisher{Storage: files, cause: test.cause, publishFirst: test.publishFirst}
			subject := newAttachmentService(database, publisher)
			namespace := transferNamespace(t)
			permit, err := files.AcquireGate(ctx, filestorage.PrivateGate, namespace.ID())
			if err != nil {
				t.Fatal(err)
			}
			defer permit.Close()
			defer func() {
				cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
				defer stop()
				if err := files.DeleteTransferNamespace(cleanupCtx, namespace); err != nil {
					t.Error(err)
				}
			}()
			admission, err := subject.AdmitTransfer(ctx, principal, task.ProjectID, task.ID, "file", "text/plain", namespace)
			if err != nil {
				t.Fatal(err)
			}
			defer admission.Close()
			item, created, err := admission.Put(ctx, strings.NewReader("after"))
			var transaction *store.TransactionError
			if !errors.Is(err, test.cause) || !FileEffectPossible(err) || !errors.As(err, &transaction) || transaction.Phase != "operation" || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted || transaction.CleanupFailed || created || !reflect.DeepEqual(item, model.Attachment{}) {
				t.Fatalf("publication failure lost outcome: item=%#v created=%v transaction=%#v err=%v", item, created, transaction, err)
			}
			if !test.publishFirst {
				requireFault(t, err, "path_conflict")
			} else {
				var fault *model.Fault
				if errors.As(err, &fault) {
					t.Fatalf("operational failure became a domain conflict: %#v", fault)
				}
			}
			if err := admission.Close(); err != nil {
				t.Fatal(err)
			}
			metadata, object, err := attachments.Open(ctx, principal, task.ProjectID, task.ID, "file")
			if err != nil {
				t.Fatal(err)
			}
			content, readErr := io.ReadAll(object.Body)
			closeErr := object.Body.Close()
			want := "before"
			if test.publishFirst {
				want = "after"
			}
			if readErr != nil || closeErr != nil || !reflect.DeepEqual(metadata, before) || string(content) != want {
				t.Fatalf("publication failure changed metadata or file unexpectedly: metadata=%#v content=%q read=%v close=%v", metadata, content, readErr, closeErr)
			}
			assertTaskUnchanged(t, tasks, principal, task)
			staged, err := files.OpenTransfer(ctx, namespace, publisher.objectID)
			if test.publishFirst {
				if !errors.Is(err, fs.ErrNotExist) {
					if err == nil {
						staged.Body.Close()
					}
					t.Fatalf("published object remained staged: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				bytes, readErr := io.ReadAll(staged.Body)
				closeErr := staged.Body.Close()
				if readErr != nil || closeErr != nil || string(bytes) != "after" {
					t.Fatalf("failed publication lost staged content: %q %v %v", bytes, readErr, closeErr)
				}
			}
		})
	}
}

type failedTransferReader struct{ err error }

func (r failedTransferReader) Read([]byte) (int, error) { return 0, r.err }

func TestPutTransferStageFailureDoesNotPublish(t *testing.T) {
	attachments, _, database, files, task, principal := attachmentService(t)
	putAttachment(t, attachments, principal, task, "file", "before")
	namespace := transferNamespace(t)
	permit, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, namespace.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	admission, err := attachments.AdmitTransfer(t.Context(), principal, task.ProjectID, task.ID, "file", "text/plain", namespace)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("injected input failure")
	_, _, err = admission.Put(t.Context(), failedTransferReader{cause})
	if !errors.Is(err, cause) || FileEffectPossible(err) {
		t.Fatalf("stage failure = %v", err)
	}
	if err := admission.Close(); err != nil {
		t.Fatal(err)
	}
	assertAttachmentState(t, t.Context(), database, files, task, true, "before")
}
