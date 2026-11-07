package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func archiveAdmissionFixture(t *testing.T, root string) *Execution {
	t.Helper()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	s := &Execution{Engine: NewEngine(files)}
	s.SetArchivePreflight(func(_ context.Context, p model.Principal, _, _, _ string, _ ArchiveMode) (string, error) {
		return p.UserID, nil
	})
	return s
}

func requireArchiveBusy(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_busy" {
		t.Fatalf("expected resource_busy, got %v", err)
	}
}

func TestArchiveOwnerAndInstanceAdmission(t *testing.T) {
	root := t.TempDir()
	first, second := archiveAdmissionFixture(t, root), archiveAdmissionFixture(t, root)
	owner, other := model.Principal{UserID: uuid.NewString()}, model.Principal{UserID: uuid.NewString()}
	ctx := context.Background()
	held, err := first.BeginArchive(ctx, owner, "", "", "", ArchiveV1Upload)
	if err != nil {
		t.Fatal(err)
	}
	_, err = first.BeginArchive(ctx, other, "", "", "", ArchiveV2Read)
	requireArchiveBusy(t, err)
	_, err = second.BeginArchive(ctx, owner, "", "", "", ArchiveV2Read)
	requireArchiveBusy(t, err)
	separate, err := second.BeginArchive(ctx, other, "", "", "", ArchiveV2Read)
	if err != nil {
		t.Fatal(err)
	}
	if err = separate.Close(); err != nil {
		t.Fatal(err)
	}
	if err = held.Close(); err != nil {
		t.Fatal(err)
	}
	if err = held.Close(); err != nil {
		t.Fatal(err)
	}
	fresh, err := second.BeginArchive(ctx, owner, "", "", "", ArchiveV1Read)
	if err != nil {
		t.Fatal(err)
	}
	if err = fresh.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchivePreflightAdmissionIsBounded(t *testing.T) {
	s := archiveAdmissionFixture(t, t.TempDir())
	entered := make(chan struct{})
	s.SetArchivePreflight(func(ctx context.Context, p model.Principal, _, _, _ string, _ ArchiveMode) (string, error) {
		close(entered)
		<-ctx.Done()
		return "", ctx.Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := s.BeginArchive(ctx, model.Principal{UserID: uuid.NewString()}, "", "", "", ArchiveV1Read)
		result <- err
	}()
	<-entered
	_, err := s.BeginArchive(context.Background(), model.Principal{UserID: uuid.NewString()}, "", "", "", ArchiveV1Read)
	requireArchiveBusy(t, err)
	cancel()
	select {
	case err = <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("metadata cancellation did not finish")
	}
}

type failedArchivePermit struct {
	calls atomic.Int32
	err   error
}

func (p *failedArchivePermit) Close() error { p.calls.Add(1); return p.err }

type failedArchiveGate struct {
	filestorage.Storage
	permit *failedArchivePermit
}

func (g failedArchiveGate) TryAcquireResidency(context.Context, string) (io.Closer, error) {
	return g.permit, nil
}
func TestArchiveClosePreservesErrorAndReleasesInstanceOnce(t *testing.T) {
	s := archiveAdmissionFixture(t, t.TempDir())
	failure := errors.New("permit close failed")
	permit := &failedArchivePermit{err: failure}
	s.files = failedArchiveGate{Storage: s.files, permit: permit}
	p := model.Principal{UserID: uuid.NewString()}
	op, err := s.BeginArchive(context.Background(), p, "", "", "", ArchiveV1Upload)
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(op.Close(), failure) || !errors.Is(op.Close(), failure) || permit.calls.Load() != 1 {
		t.Fatal("close did not retain failure or ran more than once")
	}
	next, err := s.BeginArchive(context.Background(), p, "", "", "", ArchiveV1Read)
	if err != nil {
		t.Fatal(err)
	}
	_ = next.Close()
}

type archivePermitFailureStorage struct {
	filestorage.Storage
	failure error
}
type archivePermitFailure struct {
	io.Closer
	failure error
}

func (c archivePermitFailure) Close() error { return errors.Join(c.Closer.Close(), c.failure) }
func (s archivePermitFailureStorage) TryAcquireResidency(ctx context.Context, key string) (io.Closer, error) {
	permit, err := s.Storage.TryAcquireResidency(ctx, key)
	if err != nil {
		return nil, err
	}
	return archivePermitFailure{Closer: permit, failure: s.failure}, nil
}

func TestArchiveUploadRetainsCommitWhenPermitCloseFails(t *testing.T) {
	f, v, data := archiveFixture(t)
	archiveTerminal(t, f)
	closeFailure := errors.New("permit close failed")
	f.s.files = archivePermitFailureStorage{Storage: f.s.files, failure: closeFailure}
	out, err := f.s.PutArchive(context.Background(), f.p, f.project, f.task, v.SessionID, data)
	var tx *store.TransactionError
	if out.State != "ready" || !errors.Is(err, closeFailure) || !errors.As(err, &tx) || tx.Outcome != store.TransactionCommitted || !tx.CleanupFailed || !tx.CommitAttempted {
		t.Fatalf("lost committed outcome: %+v %v", out, err)
	}
	status, err := f.s.ArchiveStatus(context.Background(), f.p, f.project, f.task, v.SessionID)
	if err != nil || status.State != "ready" {
		t.Fatalf("archive did not commit: %+v %v", status, err)
	}
}

type failedArchiveBody struct {
	io.ReadCloser
	failure error
}

func (b failedArchiveBody) Close() error { return errors.Join(b.ReadCloser.Close(), b.failure) }

type failedArchiveObjectStorage struct {
	filestorage.Storage
	failure error
}

func (s failedArchiveObjectStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	obj, err := s.Storage.Open(ctx, bucket, path)
	if err != nil {
		return obj, err
	}
	obj.Body = failedArchiveBody{ReadCloser: obj.Body, failure: s.failure}
	obj.Info.Size++
	return obj, nil
}

func TestTerminalArchiveReadPreservesValidationAndCloseFailure(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	finalizeFixture(t, f, m, doc)
	ctx := context.Background()
	data := encode(doc)
	if _, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, data); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("object close failed")
	f.s.files = failedArchiveObjectStorage{Storage: f.s.files, failure: failure}
	_, err := f.s.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID)
	var fault *model.Fault
	var original *model.Fault
	var tx *store.TransactionError
	if !errors.As(err, &fault) || fault.Code != "cleanup_unknown" || !errors.As(fault.Cause, &original) || original.Code != "source_corrupt" || !errors.Is(err, failure) || !errors.As(err, &tx) || tx.Outcome != store.TransactionNotCommitted {
		t.Fatalf("lost validation, close error or transaction outcome: %v", err)
	}
}

type failedBusyGate struct {
	filestorage.Storage
	failure error
}

func (g failedBusyGate) TryAcquireResidency(context.Context, string) (io.Closer, error) {
	return nil, errors.Join(filestorage.ErrGateBusy, g.failure)
}
func TestArchiveGateBusyCleanupFailureRemainsObservable(t *testing.T) {
	s := archiveAdmissionFixture(t, t.TempDir())
	failure := errors.New("gate close failed")
	s.files = failedBusyGate{Storage: s.files, failure: failure}
	_, err := s.BeginArchive(context.Background(), model.Principal{UserID: uuid.NewString()}, "", "", "", ArchiveV1Read)
	var fault *model.Fault
	if !errors.Is(err, failure) || !errors.Is(err, filestorage.ErrGateBusy) || errors.As(err, &fault) {
		t.Fatalf("gate cleanup failure disguised as ordinary busy: %v", err)
	}
}

func TestTerminalArchiveReadbackWithSingleDatabaseConnection(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	finalizeFixture(t, f, m, doc)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cfg := f.db.Pool.Config().Copy()
	cfg.MaxConns = 1
	cfg.MinConns = 0
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	single := New(&postgres.Store{Pool: pool}, f.s.files)
	data := encode(doc)
	if _, err = single.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, data); err != nil {
		t.Fatalf("single-connection upload and readback: %v", err)
	}
	retained, err := single.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(retained.Data, data) {
		t.Error("archive bytes changed")
	}
	if err = retained.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchivePreflightReservationSharedAndReleased(t *testing.T) {
	s := archiveAdmissionFixture(t, t.TempDir())
	p := model.Principal{UserID: uuid.NewString()}
	reserved, err := s.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.BeginArchive(context.Background(), p, "", "", "", ArchiveV1Read)
	requireArchiveBusy(t, err)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = s.BeginArchive(canceled, p, "", "", "", ArchiveV1Read); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	op, err := s.BeginArchiveReserved(context.Background(), p, "", "", "", ArchiveV1Read, reserved)
	if err != nil {
		t.Fatal(err)
	}
	if err = reserved.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = s.BeginArchive(context.Background(), p, "", "", "", ArchiveV1Read)
	requireArchiveBusy(t, err)
	if err = op.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.BeginArchiveReserved(context.Background(), p, "", "", "", ArchiveV1Read, reserved); err == nil {
		t.Fatal("reused preflight reservation")
	}
	reserved, err = s.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal(err)
	}
	if err = reserved.Close(); err != nil {
		t.Fatal(err)
	}
	if err = reserved.Close(); err != nil {
		t.Fatal(err)
	}
	op, err = s.BeginArchive(context.Background(), p, "", "", "", ArchiveV1Read)
	if err != nil {
		t.Fatal(err)
	}
	if err = op.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchivePreflightReservationConcurrentClaimAndClose(t *testing.T) {
	s := archiveAdmissionFixture(t, t.TempDir())
	p := model.Principal{UserID: uuid.NewString()}
	for i := 0; i < 32; i++ {
		reserved, err := s.TryReserveArchivePreflight()
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan *ArchiveOperation, 1)
		done := make(chan struct{})
		go func() {
			<-start
			op, _ := s.BeginArchiveReserved(context.Background(), p, "", "", "", ArchiveV1Read, reserved)
			results <- op
		}()
		go func() { <-start; _ = reserved.Close(); close(done) }()
		close(start)
		op := <-results
		<-done
		if op != nil {
			if err = op.Close(); err != nil {
				t.Fatal(err)
			}
		}
		next, err := s.TryReserveArchivePreflight()
		if err != nil {
			t.Fatalf("reservation leaked: %v", err)
		}
		_ = next.Close()
	}
}
