package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
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

func TestArchiveContentRejectsBusyBeforeReading(t *testing.T) {
	s := archiveAdmissionFixture(t, t.TempDir())
	p := model.Principal{UserID: uuid.NewString()}
	op, err := s.BeginArchive(context.Background(), p, "", "", "", ArchiveV1Upload)
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	for _, read := range []func() error{
		func() error { _, err := s.ArchiveContent(context.Background(), p, "", "", ""); return err },
		func() error { _, err := s.TerminalArchiveContent(context.Background(), p, "", "", ""); return err },
	} {
		requireArchiveBusy(t, read())
	}
}

func TestArchiveOperationRejectsWrongModeAndClosed(t *testing.T) {
	s := archiveAdmissionFixture(t, t.TempDir())
	op, err := s.BeginArchive(context.Background(), model.Principal{UserID: uuid.NewString()}, "", "", "", ArchiveV1Read)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = op.PutArchive(context.Background(), nil); err == nil {
		t.Fatal("read operation used for upload")
	}
	if _, err = op.PutTerminalArchive(context.Background(), nil); err == nil {
		t.Fatal("read operation used for terminal upload")
	}
	if err = op.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = op.PutArchive(context.Background(), nil); err == nil {
		t.Fatal("closed operation reused")
	}
}

type archiveErrorGate struct {
	filestorage.Storage
	err error
}

func (g archiveErrorGate) TryAcquireResidency(context.Context, string) (io.Closer, error) {
	return nil, g.err
}

func TestArchiveGateBusyClassification(t *testing.T) {
	busy := filestorage.ErrGateBusy
	failure := errors.New("close failure")
	for _, tc := range []struct {
		name string
		err  error
		busy bool
	}{
		{"busy", busy, true}, {"wrapped busy", fmt.Errorf("gate: %w", busy), true}, {"joined busy", errors.Join(busy), true},
		{"busy and cleanup", errors.Join(busy, failure), false}, {"failure", failure, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := archiveAdmissionFixture(t, t.TempDir())
			s.files = archiveErrorGate{Storage: s.files, err: tc.err}
			_, err := s.BeginArchive(context.Background(), model.Principal{UserID: uuid.NewString()}, "", "", "", ArchiveV1Read)
			if !errors.Is(err, tc.err) {
				t.Fatalf("lost cause: %v", err)
			}
			var f *model.Fault
			if got := errors.As(err, &f) && f.Code == "resource_busy"; got != tc.busy {
				t.Fatalf("wrong busy classification: %v", err)
			}
		})
	}
}

type preflightDAO struct {
	store.SessionDAO
	metadata                       store.ArchiveMetadata
	metadataErr, projectErr        error
	credentials                    map[string]error
	expectedPrincipal              model.Principal
	expectedProject, parent, owner string
	steps                          []string
}

func (d *preflightDAO) next(name string) {
	if len(d.steps) == 0 || d.steps[0] != name {
		panic("unexpected preflight call: " + name)
	}
	d.steps = d.steps[1:]
}
func (d *preflightDAO) ArchiveMetadata(_ context.Context, id string) (store.ArchiveMetadata, error) {
	d.next("metadata")
	if id != "id" {
		panic("unexpected session identifier")
	}
	return d.metadata, d.metadataErr
}
func (d *preflightDAO) ReadCredential(_ context.Context, p model.Principal, _ time.Time) error {
	if p == d.expectedPrincipal {
		d.next("credential")
	} else {
		d.next("parent")
	}
	if p != d.expectedPrincipal && !(p.Kind == model.PATCredential && p.CredentialID == d.parent && p.UserID == d.owner) {
		panic("unexpected credential")
	}
	return d.credentials[p.CredentialID]
}
func (d *preflightDAO) ProjectAccess(_ context.Context, user, project string) (model.ProjectAccess, error) {
	d.next("project")
	if user != d.expectedPrincipal.UserID || project != d.expectedProject || project == "" {
		panic("unexpected project access")
	}
	return model.ProjectAccess{Role: model.ProjectAdmin}, d.projectErr
}

type preflightScope struct {
	store.SessionScope
	dao store.SessionDAO
}

func (s preflightScope) SessionDAO() store.SessionDAO { return s.dao }

func TestArchivePreflightRejectsUntrustedOrRevokedAuthority(t *testing.T) {
	owner, other, cred, parent := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := model.Principal{Kind: model.PATCredential, UserID: owner, CredentialID: cred}
	project, task := uuid.NewString(), uuid.NewString()
	normal := store.ArchiveMetadata{Owner: owner, Project: project, Task: task, Backend: "web", TaskExists: true, ProjectLive: true, BotValid: true}
	standalone := store.ArchiveMetadata{Owner: owner, Backend: "web", Test: true, BotValid: true, Parent: parent}
	failure := errors.New("credential lookup failed")
	cases := []struct {
		name          string
		principal     model.Principal
		project, task string
		mode          ArchiveMode
		dao           preflightDAO
		code          string
		cause         error
	}{
		{"normal", p, project, task, ArchiveV1Read, preflightDAO{metadata: normal}, "", nil},
		{"unsupported credential", model.Principal{}, project, task, ArchiveV1Read, preflightDAO{}, "forbidden", nil},
		{"revoked credential", p, project, task, ArchiveV1Read, preflightDAO{credentials: map[string]error{cred: model.ErrNotFound}}, "unauthenticated", nil},
		{"credential read failure", p, project, task, ArchiveV1Read, preflightDAO{credentials: map[string]error{cred: failure}}, "", failure},
		{"removed membership", p, project, task, ArchiveV1Read, preflightDAO{projectErr: model.ErrNotFound}, "forbidden", nil},
		{"metadata failure", p, project, task, ArchiveV1Read, preflightDAO{metadataErr: failure}, "", failure},
		{"wrong protocol", p, project, task, ArchiveV2Read, preflightDAO{metadata: normal}, "session_conflict", nil},
		{"wrong task", p, project, uuid.NewString(), ArchiveV1Read, preflightDAO{metadata: normal}, "session_conflict", nil},
		{"task missing", p, project, task, ArchiveV1Read, preflightDAO{metadata: func() store.ArchiveMetadata { m := normal; m.TaskExists = false; return m }()}, "not_found", nil},
		{"deleted task read", p, project, task, ArchiveV1Read, preflightDAO{metadata: func() store.ArchiveMetadata { m := normal; m.TaskDeleted = true; return m }()}, "not_found", nil},
		{"deleted task owner upload", p, project, task, ArchiveV1Upload, preflightDAO{metadata: func() store.ArchiveMetadata { m := normal; m.TaskDeleted = true; return m }()}, "", nil},
		{"deleted bot", p, project, task, ArchiveV1Read, preflightDAO{metadata: func() store.ArchiveMetadata { m := normal; m.BotValid = false; return m }()}, "resource_conflict", nil},
		{"standalone other user", model.Principal{Kind: model.PATCredential, UserID: other, CredentialID: cred}, "", "", ArchiveV1Read, preflightDAO{metadata: standalone}, "forbidden", nil},
		{"parent revoked", p, "", "", ArchiveV1Read, preflightDAO{metadata: standalone, credentials: map[string]error{parent: model.ErrNotFound}}, "unauthenticated", nil},
		{"parent lookup failure", p, "", "", ArchiveV1Read, preflightDAO{metadata: standalone, credentials: map[string]error{parent: failure}}, "", failure},
		{"standalone parent valid", p, "", "", ArchiveV1Read, preflightDAO{metadata: standalone}, "", nil},
		{"nonowner upload", model.Principal{Kind: model.PATCredential, UserID: other, CredentialID: cred}, project, task, ArchiveV1Upload, preflightDAO{metadata: normal}, "forbidden", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.dao.expectedPrincipal = tc.principal
			tc.dao.expectedProject = tc.project
			tc.dao.parent = parent
			tc.dao.owner = owner
			if tc.name != "unsupported credential" {
				tc.dao.steps = append(tc.dao.steps, "credential")
				if tc.name != "revoked credential" && tc.name != "credential read failure" {
					if tc.project != "" {
						tc.dao.steps = append(tc.dao.steps, "project")
					}
					if tc.name != "removed membership" {
						tc.dao.steps = append(tc.dao.steps, "metadata")
						if tc.name == "parent revoked" || tc.name == "parent lookup failure" || tc.name == "standalone parent valid" {
							tc.dao.steps = append(tc.dao.steps, "parent")
						}
					}
				}
			}
			engine := NewEngine(nil)
			op, err := engine.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			defer op.Close()
			got, err := op.ArchivePreflight(context.Background(), preflightScope{dao: &tc.dao}, tc.principal, tc.project, tc.task, "id", tc.mode)
			if len(tc.dao.steps) != 0 {
				t.Fatalf("missing preflight calls: %v", tc.dao.steps)
			}
			if tc.code != "" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != tc.code {
					t.Fatalf("want %s, got %v", tc.code, err)
				}
				return
			}
			if tc.cause != nil {
				if !errors.Is(err, tc.cause) {
					t.Fatal(err)
				}
				return
			}
			if err != nil || got != owner {
				t.Fatalf("owner=%s err=%v", got, err)
			}
		})
	}
}

func TestTerminalArchiveRejectsChangedOwnerAndCompleteness(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	finalizeFixture(t, f, m, doc)
	ctx := context.Background()
	if _, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, encode(doc)); err != nil {
		t.Fatal(err)
	}
	preflight := f.s.archivePreflightRun
	f.s.SetArchivePreflight(func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
		return uuid.NewString(), nil
	})
	if _, err := f.s.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID); err == nil {
		t.Fatal("archive read under changed owner")
	}
	f.s.SetArchivePreflight(preflight)
	other := "partial"
	if doc.Completeness == other {
		other = "complete"
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE session_archives SET completeness=$2 WHERE session_id=$1`, m.SessionID, other); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID); err == nil {
		t.Fatal("archive completeness mismatch accepted")
	}
}

func TestArchivePreflightFailuresReleaseReservation(t *testing.T) {
	ctx := context.Background()
	p := model.Principal{UserID: uuid.NewString()}
	s := archiveAdmissionFixture(t, t.TempDir())
	fail := errors.New("preflight failed")
	for _, tc := range []struct {
		name  string
		setup func()
		want  error
	}{
		{"preflight failure", func() {
			s.SetArchivePreflight(func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
				return "", fail
			})
		}, fail},
		{"invalid owner", func() {
			s.SetArchivePreflight(func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
				return "invalid", nil
			})
		}, nil},
		{"unavailable gate", func() {
			s.SetArchivePreflight(func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
				return p.UserID, nil
			})
			s.files = nil
		}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.setup()
			_, err := s.BeginArchive(ctx, p, "", "", "", ArchiveV1Read)
			if err == nil || tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("unexpected result: %v", err)
			}
			r, err := s.TryReserveArchivePreflight()
			if err != nil {
				t.Fatalf("reservation leaked: %v", err)
			}
			_ = r.Close()
		})
	}
}
