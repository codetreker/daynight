package mcptransfer

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type lifecycleFixture struct {
	db          *postgres.Store
	files       *local.Storage
	lifecycle   *Lifecycle
	actor       transfer.Actor
	binding     transfer.Binding
	root        string
	databaseURL string
}

func newFixture(t *testing.T) lifecycleFixture {
	t.Helper()
	tasks, db, project, databaseURL, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "transfer")
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(id))
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, id, session.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	actor := transfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: session.UserID, CredentialID: id}, AuthorityKind: "pat", AuthorityID: id}
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	l, err := New(db, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := l.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return lifecycleFixture{db: db, files: files, lifecycle: l, actor: actor, root: root, databaseURL: databaseURL, binding: transfer.Binding{ID: uuid.NewString(), Direction: "upload", ProjectID: project.ID, TaskID: task.ID, Path: "file", ContentType: "text/plain", Parameters: []byte(`{"length":3}`)}}
}

func openRecord(t *testing.T, f lifecycleFixture) model.PrivateTransfer {
	t.Helper()
	r, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
	if err != nil || !created {
		t.Fatalf("open: %+v created=%v error=%v", r, created, err)
	}
	return r
}
func TestLifecycleBindingAndCurrentAuthority(t *testing.T) {
	f := newFixture(t)
	first := openRecord(t, f)
	r, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
	if err != nil || created || r.ID != first.ID {
		t.Fatalf("repeat: %+v %v %v", r, created, err)
	}
	conflict := f.binding
	conflict.Path = "different"
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, conflict); err == nil {
		t.Fatal("conflicting binding accepted")
	}
	stranger := f.actor
	stranger.Principal.UserID = uuid.NewString()
	if _, err := f.lifecycle.LookupBound(t.Context(), stranger, first.ID); err == nil {
		t.Fatal("different user accepted")
	}
	if _, err := f.db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.AuthorityID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.LookupBound(t.Context(), f.actor, first.ID); err == nil {
		t.Fatal("revoked credential accepted")
	}
}

func TestLifecycleOAuthGrantSurvivesAccessReplacement(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	grant, otherGrant := uuid.NewString(), uuid.NewString()
	for _, id := range []string{grant, otherGrant} {
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'test','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 hour')`, id, f.actor.Principal.UserID); err != nil {
			t.Fatal(err)
		}
	}
	newAccess := func(grantID string) transfer.Actor {
		id := uuid.NewString()
		hash := sha256.Sum256([]byte(id))
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, id, grantID, f.actor.Principal.UserID, hash[:]); err != nil {
			t.Fatal(err)
		}
		return transfer.Actor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: f.actor.Principal.UserID, CredentialID: id}, AuthorityKind: "oauth", AuthorityID: grantID}
	}
	first, replacement, other := newAccess(grant), newAccess(grant), newAccess(otherGrant)
	if _, created, err := f.lifecycle.OpenRecord(ctx, first, f.binding); err != nil || !created {
		t.Fatalf("open OAuth transfer: %v", err)
	}
	if _, err := f.db.Pool.Exec(ctx, `DELETE FROM oauth_access_tokens WHERE id=$1`, first.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.LookupBound(ctx, first, f.binding.ID); err == nil {
		t.Fatal("deleted access accepted")
	}
	if _, err := f.lifecycle.LookupBound(ctx, replacement, f.binding.ID); err != nil {
		t.Fatalf("same grant new access rejected: %v", err)
	}
	if _, err := f.lifecycle.LookupBound(ctx, other, f.binding.ID); err == nil {
		t.Fatal("other grant accepted")
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE oauth_grants SET revoked_at=now() WHERE id=$1`, grant); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.LookupBound(ctx, replacement, f.binding.ID); err == nil {
		t.Fatal("revoked grant accepted")
	}
}

func TestLifecycleActiveSlotLimitAndIdempotency(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 4; i++ {
		b := f.binding
		b.ID = uuid.NewString()
		if _, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, b); err != nil || !created {
			t.Fatalf("open %d: %v", i, err)
		}
		if _, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, b); err != nil || created {
			t.Fatalf("repeat %d: created=%v error=%v", i, created, err)
		}
	}
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding); err == nil {
		t.Fatal("fifth active transfer accepted")
	} else {
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "capacity_unavailable" {
			t.Fatalf("fifth active transfer: %v", err)
		}
	}
}

type failingRemoval struct {
	filestorage.TransferStorage
	err error
}

type sweepLogWriter struct{ completed chan struct{} }

func (w sweepLogWriter) Write(data []byte) (int, error) {
	var entry map[string]any
	if json.Unmarshal(data, &entry) == nil && entry["msg"] == "private transfer maintenance" {
		select {
		case w.completed <- struct{}{}:
		default:
		}
	}
	return len(data), nil
}

func (f failingRemoval) DeleteTransferNamespace(context.Context, filestorage.TransferNamespace) error {
	return f.err
}

func TestLifecycleOrphanGateFailureAndRestart(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	if _, err := f.lifecycle.Reserve(t.Context(), f.actor, r.ID, 6); err != nil {
		t.Fatal(err)
	}
	n, err := filestorage.NewTransferNamespace(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	objectID := uuid.NewString()
	// The object has no corresponding direction-specific receipt.
	if _, err := f.files.PutTransfer(p.Context, n, objectID, strings.NewReader("orphan")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Context.Done():
	case <-time.After(time.Second):
		t.Fatal("cleanup did not cancel active writer")
	}
	if err := f.lifecycle.Maintain(t.Context()); err == nil {
		t.Fatal("held gate unexpectedly reclaimed")
	}
	pending, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || pending.State != "cleanup_pending" || pending.ReservedBytes != 6 {
		t.Fatalf("held gate: %+v %v", pending, err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("disk cleanup failed")
	failed, err := New(f.db, f.files, failingRemoval{f.files, sentinel}, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := failed.Maintain(t.Context()); !errors.Is(err, sentinel) {
		t.Fatalf("cleanup failure: %v", err)
	}
	pending, err = f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || pending.State != "cleanup_pending" || pending.ReservedBytes != 6 {
		t.Fatalf("failed cleanup: %+v %v", pending, err)
	}
	if err := failed.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	// A fresh instance discovers persisted cleanup responsibility after restart.
	restarted, err := New(f.db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close(context.Background())
	if err := restarted.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	closed, err := restarted.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || closed.State != "closed" || closed.ReservedBytes != 0 {
		t.Fatalf("closed: %+v %v", closed, err)
	}
	if object, err := f.files.OpenTransfer(t.Context(), n, objectID); err == nil {
		object.Body.Close()
		t.Fatal("orphan remains")
	}
}

func TestLifecycleShutdownCancelsAndWaitsForPermit(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.Start(nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if err := f.lifecycle.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close should wait: %v", err)
	}
	select {
	case <-p.Context.Done():
	default:
		t.Fatal("shutdown did not cancel operation")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel2()
	if err := f.lifecycle.Close(ctx2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID); err == nil {
		t.Fatal("admitted after shutdown")
	}
}

func TestLifecycleActivePermitRenewsIdleDeadline(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	before := time.Now().Add(5 * time.Minute)
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET expires_at=$2 WHERE id=$1`, r.ID, before); err != nil {
		t.Fatal(err)
	}
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	updated, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.ExpiresAt.After(before.Add(30*time.Minute)) || updated.ExpiresAt.After(updated.HardExpiresAt) {
		t.Fatalf("active call did not renew bounded deadline: %+v", updated)
	}
}

func TestLifecyclePendingCommitRecordsOnlyOriginalOperation(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	r, err = f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	operation := uuid.NewString()
	data := json.RawMessage(`{"operationId":"` + operation + `"}`)
	lease := time.Now().Add(45 * time.Second)
	r, err = f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "committing", data, &lease)
	if err != nil {
		t.Fatal(err)
	}
	r, err = f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID)
	if err != nil || r.State != "cleanup_pending" {
		t.Fatalf("cleanup barrier: %+v %v", r, err)
	}
	if _, err := f.db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.AuthorityID); err != nil {
		t.Fatal(err)
	}
	different := json.RawMessage(`{"operationId":"` + uuid.NewString() + `","receipt":"different"}`)
	if _, err := f.lifecycle.CompletePending(t.Context(), permit, f.actor, r.ID, r.Version, "committed", different); err == nil {
		t.Fatal("different operation accepted")
	}
	facts := json.RawMessage(`{"operationId":"` + operation + `","receipt":"confirmed"}`)
	r, err = f.lifecycle.CompletePending(t.Context(), permit, f.actor, r.ID, r.Version, "committed", facts)
	if err != nil || r.State != "cleanup_pending" || r.CleanupFromState == nil || *r.CleanupFromState != "committed" || transfer.OperationID(r.Data) != operation {
		t.Fatalf("late completion: %+v %v", r, err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.CompletePending(t.Context(), permit, f.actor, r.ID, r.Version, "committed", facts); err == nil {
		t.Fatal("completion accepted after permit release")
	}
}

func TestLifecyclePublishedReceiptAndReservationAreAtomic(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	r, err := f.lifecycle.Reserve(t.Context(), f.actor, r.ID, 8)
	if err != nil {
		t.Fatal(err)
	}
	permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	r, err = f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	n, err := filestorage.NewTransferNamespace(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.files.PutTransfer(permit.Context, n, uuid.NewString(), strings.NewReader("12345678")); err != nil {
		t.Fatal(err)
	}
	// Fail the receipt UPDATE after ConsumeReservation runs in the same transaction.
	if _, err := f.db.Pool.Exec(t.Context(), `CREATE FUNCTION reject_transfer_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data->>'receipt' = 'fail' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_transfer_receipt BEFORE UPDATE ON private_transfers FOR EACH ROW EXECUTE FUNCTION reject_transfer_receipt()`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.TransitionPublished(t.Context(), permit, f.actor, r.ID, r.Version, "receiving", json.RawMessage(`{"receipt":"fail"}`), nil, 8); err == nil {
		t.Fatal("injected receipt failure was hidden")
	}
	after, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || after.Version != r.Version || after.OutstandingBytes != 8 || after.ReservedBytes != 8 || string(after.Data) != string(r.Data) {
		t.Fatalf("partial transaction: before=%+v after=%+v err=%v", r, after, err)
	}
	after, err = f.lifecycle.TransitionPublished(t.Context(), permit, f.actor, r.ID, r.Version, "receiving", json.RawMessage(`{"receipt":"accepted"}`), nil, 8)
	if err != nil || after.ReservedBytes != 8 || after.OutstandingBytes != 0 || !strings.Contains(string(after.Data), "accepted") {
		t.Fatalf("published receipt: %+v %v", after, err)
	}
}

func TestLifecycleBlockedAuthorizationDoesNotStarveOtherUser(t *testing.T) {
	f := newFixture(t)
	first := openRecord(t, f)
	user := testsupport.ServicePrincipal(t, f.db)
	project, err := projectservice.NewProjects(f.db).Create(t.Context(), user, coreproject.CreateProject{ExpectedUserID: user.UserID, Name: "other", RepoURL: "git@host:other"})
	if err != nil {
		t.Fatal(err)
	}
	task := testsupport.CreateTask(t, taskservice.NewTasks(f.db), user, project.ID, "other transfer")
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(id))
	if _, err := f.db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, id, user.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	actor := transfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: user.UserID, CredentialID: id}, AuthorityKind: "pat", AuthorityID: id}
	binding := transfer.Binding{ID: uuid.NewString(), Direction: "download", ProjectID: project.ID, TaskID: task.ID, Path: "file"}
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), actor, binding); err != nil {
		t.Fatal(err)
	}
	tx, err := f.db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var pid int32
	if err := tx.QueryRow(t.Context(), `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `SELECT 1 FROM project_ownership WHERE project_id=$1 FOR UPDATE`, f.binding.ProjectID); err != nil {
		t.Fatal(err)
	}
	blockedCtx, cancelBlocked := context.WithCancel(t.Context())
	defer cancelBlocked()
	result := make(chan error, 1)
	go func() { _, err := f.lifecycle.LookupBound(blockedCtx, f.actor, first.ID); result <- err }()
	waitCtx, waitCancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer waitCancel()
	for {
		var waiting bool
		if err := f.db.Pool.QueryRow(waitCtx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-result:
			t.Fatalf("lookup did not block: %v", err)
		case <-waitCtx.Done():
			t.Fatal("lookup never blocked")
		case <-time.After(10 * time.Millisecond):
		}
	}
	independent, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if _, err := f.lifecycle.LookupBound(independent, actor, binding.ID); err != nil {
		t.Fatalf("other status starved: %v", err)
	}
	if _, err := f.lifecycle.RequestCleanup(independent, actor, binding.ID); err != nil {
		t.Fatalf("other abort starved: %v", err)
	}
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("blocked lookup did not finish")
	}
}

func TestLifecycleShutdownAllowsPendingCommitReceiptBeforePermitRelease(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	r, err = f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	op := uuid.NewString()
	data := json.RawMessage(`{"operationId":"` + op + `"}`)
	lease := time.Now().Add(45 * time.Second)
	r, err = f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "committing", data, &lease)
	if err != nil {
		t.Fatal(err)
	}
	other, err := New(f.db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close(context.Background())
	r, err = other.RequestCleanup(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-permit.Context.Done():
		t.Fatal("remote cleanup unexpectedly canceled local permit")
	default:
	}
	closed := make(chan error, 1)
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { closed <- f.lifecycle.Close(closeCtx) }()
	for {
		f.lifecycle.mu.Lock()
		stopping := f.lifecycle.stopping
		f.lifecycle.mu.Unlock()
		if stopping {
			break
		}
		select {
		case err := <-closed:
			t.Fatalf("Close returned before stopping: %v", err)
		case <-closeCtx.Done():
			t.Fatal("Close did not start")
		case <-time.After(5 * time.Millisecond):
		}
	}
	select {
	case <-permit.Context.Done():
	case <-time.After(time.Second):
		t.Fatal("Close did not cancel permit")
	}
	// Close must not return before this operation has recorded its result and
	// released its gate; the canceled operation context is no longer usable.
	select {
	case err := <-closed:
		t.Fatalf("Close returned with permit held: %v", err)
	default:
	}
	completed, err := f.lifecycle.FinishCommit(permit.Context, permit, f.actor, r.ID, r.Version, "committed", json.RawMessage(`{"operationId":"`+op+`","receipt":"confirmed"}`))
	if err != nil || completed.CleanupFromState == nil || *completed.CleanupFromState != "committed" {
		t.Fatalf("shutdown completion: %+v %v", completed, err)
	}
	select {
	case err := <-closed:
		t.Fatalf("Close returned before permit release: %v", err)
	default:
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not join")
	}
	var state, receipt string
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT cleanup_from_state,data->>'receipt' FROM private_transfers WHERE id=$1`, r.ID).Scan(&state, &receipt); err != nil {
		t.Fatal(err)
	}
	if state != "committed" || receipt != "confirmed" {
		t.Fatalf("persisted receipt: %q %q", state, receipt)
	}
}

func TestLifecycleBindingJSONNumbersAreExactAndEquivalent(t *testing.T) {
	f := newFixture(t)
	f.binding.Parameters = json.RawMessage(`{"amount":1000,"large":9007199254740993}`)
	openRecord(t, f)
	same := f.binding
	same.Parameters = json.RawMessage(`{"large":9007199254740993,"amount":1e3}`)
	if _, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, same); err != nil || created {
		t.Fatalf("equivalent JSON binding: created=%v error=%v", created, err)
	}
	different := f.binding
	different.Parameters = json.RawMessage(`{"amount":1e3,"large":9007199254740992}`)
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, different); err == nil {
		t.Fatal("distinct large integer accepted")
	}
}

func TestLifecycleCrossProcessCrashRecovery(t *testing.T) {
	if root := os.Getenv("DAYNIGHT_TRANSFER_RESTART_ROOT"); root != "" {
		db, err := postgres.Open(t.Context(), os.Getenv("DAYNIGHT_TRANSFER_RESTART_DATABASE"))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		files, err := local.New(root)
		if err != nil {
			t.Fatal(err)
		}
		defer files.Close()
		restarted, err := New(db, files, files, 1<<30, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer restarted.Close(context.Background())
		sweepDone := make(chan struct{}, 1)
		restarted.SetLogger(slog.New(slog.NewJSONHandler(sweepLogWriter{completed: sweepDone}, nil)))
		if err := restarted.Start(nil); err != nil {
			t.Fatal(err)
		}
		select {
		case <-sweepDone:
		case <-time.After(10 * time.Second):
			t.Fatal("startup sweep did not finish")
		}
		var state string
		var reserved int64
		if err := db.Pool.QueryRow(t.Context(), `SELECT state,reserved_bytes FROM private_transfers WHERE id=$1`, os.Getenv("DAYNIGHT_TRANSFER_RESTART_ID")).Scan(&state, &reserved); err != nil {
			t.Fatal(err)
		}
		if state != "closed" || reserved != 0 {
			t.Fatalf("startup sweep left %s with %d bytes", state, reserved)
		}
		fmt.Println("recovered")
		return
	}
	if root := os.Getenv("DAYNIGHT_TRANSFER_CRASH_ROOT"); root != "" {
		files, err := local.New(root)
		if err != nil {
			t.Fatal(err)
		}
		defer files.Close()
		id, objectID := os.Getenv("DAYNIGHT_TRANSFER_CRASH_ID"), os.Getenv("DAYNIGHT_TRANSFER_CRASH_OBJECT")
		n, err := filestorage.NewTransferNamespace(id)
		if err != nil {
			t.Fatal(err)
		}
		permit, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, id)
		if err != nil {
			t.Fatal(err)
		}
		defer permit.Close()
		if _, err := files.PutTransfer(t.Context(), n, objectID, strings.NewReader("orphan")); err != nil {
			t.Fatal(err)
		}
		fmt.Println("published")
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	f := newFixture(t)
	r := openRecord(t, f)
	if _, err := f.lifecycle.Reserve(t.Context(), f.actor, r.ID, 6); err != nil {
		t.Fatal(err)
	}
	objectID := uuid.NewString()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLifecycleCrossProcessCrashRecovery$")
	cmd.Env = append(os.Environ(), "DAYNIGHT_TRANSFER_CRASH_ROOT="+f.root, "DAYNIGHT_TRANSFER_CRASH_ID="+r.ID, "DAYNIGHT_TRANSFER_CRASH_OBJECT="+objectID)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		_ = stdin.Close()
		if !waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	lines := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			lines <- scanner.Text()
		} else {
			lines <- ""
		}
	}()
	select {
	case line := <-lines:
		if line != "published" {
			t.Fatalf("child did not publish: %q", line)
		}
	case <-ctx.Done():
		t.Fatal("child did not publish in time")
	}
	if _, err := f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.Maintain(t.Context()); err == nil {
		t.Fatal("cross-process gate did not prevent deletion")
	}
	pending, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || pending.State != "cleanup_pending" || pending.ReservedBytes != 6 {
		t.Fatalf("held gate: %+v %v", pending, err)
	}
	n, err := filestorage.NewTransferNamespace(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	object, err := f.files.OpenTransfer(t.Context(), n, objectID)
	if err != nil {
		t.Fatalf("orphan missing while writer lives: %v", err)
	}
	object.Body.Close()
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("writer unexpectedly exited normally")
	}
	waited = true
	if err := f.lifecycle.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	restart := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLifecycleCrossProcessCrashRecovery$")
	restart.Env = append(os.Environ(), "DAYNIGHT_TRANSFER_RESTART_ROOT="+f.root, "DAYNIGHT_TRANSFER_RESTART_DATABASE="+f.databaseURL, "DAYNIGHT_TRANSFER_RESTART_ID="+r.ID)
	output, err := restart.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "recovered") {
		t.Fatalf("restart process did not recover orphan: %v", err)
	}
	if object, err := f.files.OpenTransfer(t.Context(), n, objectID); err == nil {
		object.Body.Close()
		t.Fatal("orphan remains after restart")
	}
}

func TestLifecycleMaintenanceLogsSafeFacts(t *testing.T) {
	f := newFixture(t)
	const secret = "sensitive-content-never-log-8f21"
	f.binding.Path = secret
	f.binding.Parameters = json.RawMessage(`{"private":"` + secret + `"}`)
	r := openRecord(t, f)
	if _, err := f.lifecycle.Reserve(t.Context(), f.actor, r.ID, 6); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	failure := errors.New(secret)
	failed, err := New(f.db, f.files, failingRemoval{f.files, failure}, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer failed.Close(context.Background())
	var output bytes.Buffer
	failed.SetLogger(slog.New(slog.NewJSONHandler(&output, nil)))
	if err := failed.Maintain(t.Context()); !errors.Is(err, failure) {
		t.Fatalf("cleanup failure: %v", err)
	}
	var entries []map[string]any
	scanner := bufio.NewScanner(&output)
	for scanner.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected cleanup and metrics, got %v", entries)
	}
	if entries[0]["transfer_id"] != r.ID || entries[0]["phase"] != "cleanup" || entries[0]["sweep_id"] == "" || entries[0]["sweep_id"] != entries[1]["sweep_id"] {
		t.Fatalf("missing correlation: %v", entries)
	}
	if entries[1]["temp_reserved_bytes"] != float64(6) || entries[1]["temp_budget_bytes"] != float64(1<<30) || entries[1]["cleanup_backlog"] != float64(1) || entries[1]["cleanup_oldest"] == nil {
		t.Fatalf("missing metrics: %v", entries)
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), secret) {
		t.Fatal("logs expose submitted data or filesystem errors")
	}
}

func TestLifecycleFinishedTransferCannotReserve(t *testing.T) {
	for _, state := range []string{"committed", "failed", "unknown"} {
		t.Run(state, func(t *testing.T) {
			f := newFixture(t)
			r := openRecord(t, f)
			r, err := f.lifecycle.Reserve(t.Context(), f.actor, r.ID, 8)
			if err != nil {
				t.Fatal(err)
			}
			permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer permit.Close()
			r, err = f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
			if err != nil {
				t.Fatal(err)
			}
			op := uuid.NewString()
			data := json.RawMessage(`{"operationId":"` + op + `"}`)
			lease := time.Now().Add(45 * time.Second)
			r, err = f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "committing", data, &lease)
			if err != nil {
				t.Fatal(err)
			}
			if state == "unknown" {
				r, err = f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, state, data, nil)
			} else {
				r, err = f.lifecycle.FinishCommit(t.Context(), permit, f.actor, r.ID, r.Version, state, data)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.lifecycle.Reserve(t.Context(), f.actor, r.ID, 1); err == nil {
				t.Fatalf("%s transfer accepted reservation", state)
			}
			current, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
			if err != nil || current.State != state || current.ReservedBytes != 8 {
				t.Fatalf("reservation altered terminal state: %+v %v", current, err)
			}
		})
	}
}

func TestEqualJSONExtremeExponentsBounded(t *testing.T) {
	if os.Getenv("DAYNIGHT_TEST_DECIMAL_CHILD") == "1" {
		for _, tc := range []struct {
			a, b  string
			equal bool
		}{
			{"1000", "1e3", true},
			{"9007199254740993", "9007199254740992", false},
			{"1", "1e1000000", false},
			{"1", "1e-1000000", false},
			{"1", "1e1000000000", false},
			{"1", "1e-1000000000", false},
			{"0", "0e1000000000", true},
			{"0", "-0.000e-1000000000", true},
		} {
			if got := transfer.EqualJSON(json.Number(tc.a), json.Number(tc.b)); got != tc.equal {
				t.Errorf("compare %s and %s: got %v, want %v", tc.a, tc.b, got, tc.equal)
			}
		}
		return
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestEqualJSONExtremeExponentsBounded$")
	cmd.Env = append(os.Environ(), "DAYNIGHT_TEST_DECIMAL_CHILD=1")
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("extreme exponent comparison exceeded time bound: %v", ctx.Err())
	}
	if err != nil {
		t.Fatalf("extreme exponent comparison: %v\n%s", err, output)
	}
}

type constrainedStorage struct {
	filestorage.TransferStorage
	free int64
	err  error
}

func (s constrainedStorage) AvailableTransferBytes(context.Context) (int64, error) {
	return s.free, s.err
}

type failedWriter struct {
	completion store.Completion
	err        error
}

func (w failedWriter) WritePrivateTransfer(context.Context, func(store.PrivateTransferDAO) error) (store.Completion, error) {
	return w.completion, w.err
}

func TestLifecycleCapacityAndStorageFailures(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	for _, tc := range []struct {
		name           string
		free, reserved int64
		want           error
	}{
		{"disk reserve", 9, 10, transfer.ErrCapacity},
		{"insufficient bytes", 12, 10, transfer.ErrCapacity},
		{"sampling failure", 0, 0, errors.New("disk unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var sampling error
			if tc.name == "sampling failure" {
				sampling = tc.want
			}
			l, err := New(f.db, f.files, constrainedStorage{f.files, tc.free, sampling}, 100, tc.reserved)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close(context.Background())
			if _, err := l.Reserve(t.Context(), f.actor, r.ID, 3); !errors.Is(err, tc.want) {
				t.Fatalf("capacity result: %v", err)
			}
		})
	}
	l, err := New(f.db, f.files, f.files, 4, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close(context.Background())
	if _, err := l.Reserve(t.Context(), f.actor, r.ID, 5); err == nil {
		t.Fatal("budget exceeded")
	}
	current, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || current.ReservedBytes != 0 {
		t.Fatalf("failed reservation changed ledger: %+v %v", current, err)
	}
}

func TestLifecycleInputAndTransitionRefusals(t *testing.T) {
	f := newFixture(t)
	if _, err := New(nil, f.files, f.files, 1, 0); err == nil {
		t.Fatal("nil store accepted")
	}
	if _, err := New(f.db, f.files, f.files, 0, 0); err == nil {
		t.Fatal("zero budget accepted")
	}
	bad := f.actor
	bad.AuthorityID = uuid.NewString()
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), bad, f.binding); err == nil {
		t.Fatal("mismatched PAT accepted")
	}
	if _, err := f.lifecycle.LookupBound(t.Context(), transfer.Actor{}, f.binding.ID); err == nil {
		t.Fatal("missing actor accepted")
	}
	if _, err := f.lifecycle.LookupBound(t.Context(), f.actor, "invalid"); err == nil {
		t.Fatal("invalid ID accepted")
	}
	binding := f.binding
	binding.ID = "bad"
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, binding); err == nil {
		t.Fatal("invalid binding accepted")
	}
	binding = f.binding
	binding.Parameters = json.RawMessage(`{} {}`)
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, binding); err == nil {
		t.Fatal("multiple JSON values accepted")
	}
	binding.Parameters = json.RawMessage(`{`)
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, binding); err == nil {
		t.Fatal("malformed JSON accepted")
	}
	if _, err := f.lifecycle.Reserve(t.Context(), f.actor, f.binding.ID, -1); err == nil {
		t.Fatal("negative reservation accepted")
	}
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, "bad"); err == nil {
		t.Fatal("bad permit ID accepted")
	}
	r := openRecord(t, f)
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "readable", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("upload transitioned to readable")
	}
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version+1, "receiving", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("stale version accepted")
	}
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "receiving", json.RawMessage(`{`), nil); err == nil {
		t.Fatal("malformed receipt accepted")
	}
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "committing", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("unfenced commit accepted")
	}
	if _, err := f.lifecycle.TransitionPublished(t.Context(), nil, f.actor, r.ID, r.Version, "receiving", json.RawMessage(`{}`), nil, 0); err == nil {
		t.Fatal("publication without gate accepted")
	}
	if _, err := f.lifecycle.FinishCommit(t.Context(), nil, f.actor, r.ID, r.Version, "committed", json.RawMessage(`{}`)); err == nil {
		t.Fatal("completion without gate accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := f.lifecycle.AcquirePermit(ctx, f.actor, r.ID); err == nil {
		t.Fatal("canceled permit admitted")
	}
	if _, err := f.lifecycle.RequestCleanup(t.Context(), transfer.Actor{}, r.ID); err == nil {
		t.Fatal("cleanup without actor accepted")
	}
}

func TestLifecycleExpiredLeaseAndIdleRecovery(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	unchanged, err := f.lifecycle.markDue(t.Context(), r.ID, time.Now().UTC())
	if err != nil || unchanged.State != "receiving" {
		t.Fatalf("live transfer: %+v %v", unchanged, err)
	}
	permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	r, err = f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	data := json.RawMessage(`{"operationId":"` + uuid.NewString() + `"}`)
	lease := time.Now().Add(45 * time.Second)
	r, err = f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "committing", data, &lease)
	if err != nil {
		t.Fatal(err)
	}
	unchanged, err = f.lifecycle.markDue(t.Context(), r.ID, time.Now().UTC())
	if err != nil || unchanged.State != "committing" {
		t.Fatalf("active lease: %+v %v", unchanged, err)
	}
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET lease_until=now()-interval '1 second' WHERE id=$1`, r.ID); err != nil {
		t.Fatal(err)
	}
	pending, err := f.lifecycle.markDue(t.Context(), r.ID, time.Now().UTC())
	if err != nil || pending.State != "cleanup_pending" || pending.CleanupFromState == nil || *pending.CleanupFromState != "unknown" {
		t.Fatalf("expired lease: %+v %v", pending, err)
	}
	pending, err = f.lifecycle.markDue(t.Context(), r.ID, time.Now().UTC())
	if err != nil || pending.State != "cleanup_pending" {
		t.Fatalf("pending: %+v %v", pending, err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	closed, err := f.lifecycle.markDue(t.Context(), r.ID, time.Now().UTC())
	if err != nil || closed.State != "closed" {
		t.Fatalf("closed: %+v %v", closed, err)
	}
	other := f.binding
	other.ID = uuid.NewString()
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, other); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET expires_at=now()-interval '1 second' WHERE id=$1`, other.ID); err != nil {
		t.Fatal(err)
	}
	pending, err = f.lifecycle.markDue(t.Context(), other.ID, time.Now().UTC())
	if err != nil || pending.State != "cleanup_pending" {
		t.Fatalf("expired idle: %+v %v", pending, err)
	}
}

func TestLifecycleUnconfirmedTransaction(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct {
		name   string
		writer failedWriter
	}{
		{"unknown", failedWriter{completion: store.Completion{Outcome: store.TransactionUnknown}}},
		{"failure", failedWriter{completion: store.Completion{Outcome: store.TransactionNotCommitted}, err: errors.New("storage failed")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l, err := New(tc.writer, f.files, f.files, 100, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close(context.Background())
			if _, _, err := l.OpenRecord(t.Context(), f.actor, f.binding); err == nil {
				t.Fatal("unconfirmed transaction reported success")
			}
		})
	}
}

func TestLifecycleDownloadStateAndPermitFences(t *testing.T) {
	f := newFixture(t)
	f.binding.Direction = "download"
	r := openRecord(t, f)
	if r.State != "preparing" {
		t.Fatalf("initial download: %s", r.State)
	}
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "committing", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("download commit accepted")
	}
	r, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "readable", json.RawMessage(`{"size":8}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	r, err = f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.TransitionPublished(t.Context(), permit, f.actor, uuid.NewString(), r.Version, "readable", json.RawMessage(`{}`), nil, 1); err == nil {
		t.Fatal("permit used for another transfer")
	}
	if _, err := f.lifecycle.TransitionPublished(t.Context(), permit, f.actor, r.ID, r.Version, "readable", json.RawMessage(`{}`), nil, -1); err == nil {
		t.Fatal("negative publication accepted")
	}
	r, err = f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "readable", json.RawMessage(`{"size":8}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.FinishCommit(t.Context(), permit, f.actor, r.ID, r.Version, "committed", json.RawMessage(`{}`)); err == nil {
		t.Fatal("download accepted commit completion")
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.TransitionPublished(t.Context(), permit, f.actor, r.ID, r.Version, "readable", json.RawMessage(`{}`), nil, 0); err == nil {
		t.Fatal("closed permit accepted")
	}
}

func TestEqualJSONStructuredBindings(t *testing.T) {
	parse := func(value string) any {
		t.Helper()
		var result any
		decoder := json.NewDecoder(strings.NewReader(value))
		decoder.UseNumber()
		if err := decoder.Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, tc := range []struct {
		a, b  string
		equal bool
	}{
		{`[1,{"v":3}]`, `[1.0,{"v":3e0}]`, true},
		{`[1,2]`, `[1]`, false},
		{`[1]`, `[2]`, false},
		{`[1]`, `{"v":1}`, false},
		{`{"a":1}`, `{"b":1}`, false},
		{`{"a":1}`, `{"a":1,"b":2}`, false},
		{`1`, `"1"`, false},
		{`null`, `null`, true},
	} {
		if got := transfer.EqualJSON(parse(tc.a), parse(tc.b)); got != tc.equal {
			t.Errorf("%s versus %s: %v", tc.a, tc.b, got)
		}
	}
}

type notifiedGate struct {
	filestorage.Storage
	entered chan struct{}
}

func (g notifiedGate) AcquireGate(ctx context.Context, domain filestorage.GateDomain, id string) (io.Closer, error) {
	close(g.entered)
	return g.Storage.AcquireGate(ctx, domain, id)
}

func TestLifecycleRechecksRevocationAfterWaitingForGate(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	gate, err := f.files.AcquireGate(t.Context(), filestorage.PrivateGate, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	entered := make(chan struct{})
	l, err := New(f.db, notifiedGate{f.files, entered}, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close(context.Background())
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		p, err := l.AcquirePermit(ctx, f.actor, r.ID)
		if p != nil {
			_ = p.Close()
		}
		result <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("permit did not wait for gate")
	}
	if _, err := f.db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.AuthorityID); err != nil {
		t.Fatal(err)
	}
	if err := gate.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("revoked credential admitted after gate wait")
		}
	case <-ctx.Done():
		t.Fatal("permit did not finish")
	}
	probe, err := f.files.AcquireGate(ctx, filestorage.PrivateGate, r.ID)
	if err != nil {
		t.Fatalf("rejected permit leaked gate: %v", err)
	}
	probe.Close()
}

func TestBindingNumberLimitsAndOperationFences(t *testing.T) {
	for _, tc := range []struct {
		a, b  string
		equal bool
	}{
		{"-1.20", "-12e-1", true},
		{"1e9223372036854775808", "1", false},
		{"1.1e-9223372036854775808", "1", false},
		{"10e9223372036854775807", "1", false},
	} {
		if got := transfer.EqualJSON(json.Number(tc.a), json.Number(tc.b)); got != tc.equal {
			t.Errorf("%s versus %s: %v", tc.a, tc.b, got)
		}
	}
	if got := transfer.OperationID(json.RawMessage(`{"operationId":2}`)); got != "" {
		t.Fatalf("invalid operation ID: %q", got)
	}
	for _, terminal := range []string{"closed", "failed", "committed", "cleanup_pending"} {
		if transfer.Allowed(terminal, "receiving") {
			t.Errorf("%s transfer can restart", terminal)
		}
	}
	if !transfer.Allowed("unknown", "unknown") || transfer.Allowed("unknown", "committing") {
		t.Fatal("unknown commit permits replay")
	}
}

type failedGate struct {
	filestorage.Storage
	err error
}

func (g failedGate) AcquireGate(context.Context, filestorage.GateDomain, string) (io.Closer, error) {
	return nil, g.err
}

type lateGate struct {
	filestorage.Storage
	entered chan struct{}
	release chan struct{}
}

func (g lateGate) AcquireGate(ctx context.Context, domain filestorage.GateDomain, id string) (io.Closer, error) {
	p, err := g.Storage.AcquireGate(ctx, domain, id)
	if err != nil {
		return nil, err
	}
	close(g.entered)
	<-g.release
	return p, nil
}

func TestLifecyclePermitFailureAndLateShutdown(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	failure := errors.New("gate unavailable")
	l, err := New(f.db, failedGate{f.files, failure}, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.AcquirePermit(t.Context(), f.actor, r.ID); !errors.Is(err, failure) {
		t.Fatalf("gate failure: %v", err)
	}
	if err := l.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	late, err := New(f.db, lateGate{f.files, entered, release}, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		p, err := late.AcquirePermit(t.Context(), f.actor, r.ID)
		if p != nil {
			p.Close()
		}
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("gate did not acquire")
	}
	closeResult := make(chan error, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	go func() { closeResult <- late.Close(ctx) }()
	for {
		late.mu.Lock()
		stopping := late.stopping
		late.mu.Unlock()
		if stopping {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("shutdown did not start")
		case <-time.After(5 * time.Millisecond):
		}
	}
	close(release)
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("permit admitted during shutdown")
		}
	case <-ctx.Done():
		t.Fatal("permit did not finish")
	}
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("shutdown did not join")
	}
	p, err := f.files.AcquireGate(ctx, filestorage.PrivateGate, r.ID)
	if err != nil {
		t.Fatalf("late permit leaked gate: %v", err)
	}
	p.Close()
}

func TestLifecyclePermitRejectsTerminalAndCapsRenewal(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET expires_at=now()+interval '10 seconds',hard_expires_at=now()+interval '30 seconds' WHERE id=$1`, r.ID); err != nil {
		t.Fatal(err)
	}
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	current, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !current.ExpiresAt.Equal(current.HardExpiresAt) {
		t.Fatal("renewal exceeded maximum lifetime")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID); err == nil {
		t.Fatal("cleanup pending admitted")
	}
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, uuid.NewString()); err == nil {
		t.Fatal("missing transfer admitted")
	}
}
