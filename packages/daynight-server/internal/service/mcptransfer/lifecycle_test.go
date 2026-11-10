package mcptransfer

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestLifecycleBindingAndCurrentAuthority(t *testing.T) {
	f := newFixture(t)
	r := openRecord(t, f)
	f.expect(get(r), auth(f.actor, r, nil))
	got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
	if err != nil || created || !reflect.DeepEqual(got, r) {
		t.Fatalf("repeat: %+v %v %v", got, created, err)
	}
	conflict := f.binding
	conflict.Path = "different"
	f.expect(get(r))
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, conflict); !errors.Is(err, ErrConflict) {
		t.Fatalf("binding conflict: %v", err)
	}
	stranger := f.actor
	stranger.Principal.UserID = uuid.NewString()
	f.expect(get(r))
	if _, err := f.lifecycle.LookupBound(t.Context(), stranger, r.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("other owner: %v", err)
	}
	f.expect(get(r), auth(f.actor, r, model.ErrNotFound))
	if _, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID); err == nil {
		t.Fatal("current authority refusal ignored")
	}
}

func TestLifecycleOAuthGrantSurvivesAccessReplacement(t *testing.T) {
	f := newFixture(t)
	grant := uuid.NewString()
	first := transfer.Actor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: f.actor.Principal.UserID, CredentialID: uuid.NewString()}, AuthorityKind: "oauth", AuthorityID: grant}
	f.actor = first
	r := f.record()
	f.expect(get(r), auth(first, r, nil))
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), first, f.binding); err != nil {
		t.Fatal(err)
	}
	replacement := first
	replacement.Principal.CredentialID = uuid.NewString()
	other := replacement
	other.AuthorityID = uuid.NewString()
	f.expect(get(r), auth(first, r, model.ErrNotFound))
	if _, err := f.lifecycle.LookupBound(t.Context(), first, r.ID); err == nil {
		t.Fatal("deleted access accepted")
	}
	f.expect(get(r), auth(replacement, r, nil))
	if _, err := f.lifecycle.LookupBound(t.Context(), replacement, r.ID); err != nil {
		t.Fatal(err)
	}
	f.expect(get(r))
	if _, err := f.lifecycle.LookupBound(t.Context(), other, r.ID); err == nil {
		t.Fatal("other grant accepted")
	}
	f.expect(get(r), auth(replacement, r, model.ErrNotFound))
	if _, err := f.lifecycle.LookupBound(t.Context(), replacement, r.ID); err == nil {
		t.Fatal("revoked grant accepted")
	}
}

func TestLifecycleExistingRecordsAreIdempotent(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 4; i++ {
		b := f.binding
		b.ID = uuid.NewString()
		f.binding = b
		r := f.record()
		f.expect(get(r), auth(f.actor, r, nil))
		got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, b)
		if err != nil || created || !reflect.DeepEqual(got, r) {
			t.Fatalf("repeat %d: %+v created=%v error=%v", i, got, created, err)
		}
	}
}

type failingRemoval struct {
	filestorage.TransferStorage
	err error
}

func (f failingRemoval) DeleteTransferNamespace(context.Context, filestorage.TransferNamespace) error {
	return f.err
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
func pendingRecord(r model.PrivateTransfer, from string) model.PrivateTransfer {
	r = cloneTransfer(r)
	r.State = "cleanup_pending"
	r.CleanupFromState = &from
	r.Version++
	return r
}
func (f lifecycleFixture) expectCleanup(r model.PrivateTransfer) model.PrivateTransfer {
	steps := []daoStep{get(r), auth(f.actor, r, nil)}
	current := cloneTransfer(r)
	if current.State == "committing" {
		unknown := cloneTransfer(current)
		unknown.State = "unknown"
		unknown.LeaseUntil = nil
		unknown.Version++
		proposed := cloneTransfer(unknown)
		proposed.Version = current.Version
		steps = append(steps, get(current), put(proposed, current.Version, unknown, nil))
		current = unknown
	}
	result := pendingRecord(current, current.State)
	want := cloneTransfer(result)
	want.Version = current.Version
	steps = append(steps, get(current), daoStep{method: "Put", check: func(args []any) {
		v := args[0].(model.PrivateTransfer)
		if v.UpdatedAt.Before(want.UpdatedAt) || v.UpdatedAt.After(time.Now()) {
			f.t.Errorf("cleanup timestamp: %v", v.UpdatedAt)
		}
		v.UpdatedAt = want.UpdatedAt
		if !reflect.DeepEqual(v, want) || args[1] != current.Version {
			f.t.Errorf("cleanup write: %+v", args)
		}
	}, result: result})
	f.expect(steps...)
	return result
}
func (f lifecycleFixture) expectClose(r model.PrivateTransfer) model.PrivateTransfer {
	result := cloneTransfer(r)
	result.State = "closed"
	result.ReservedBytes = 0
	result.OutstandingBytes = 0
	result.Version++
	f.expect(get(r), get(r), method("LockLedger", nil, nil), daoStep{method: "Release", check: func(args []any) {
		if !reflect.DeepEqual(args[0], r) || args[1] != r.Version || args[3] != "closed" {
			f.t.Errorf("release: %+v", args)
		}
		until := args[2].(time.Time)
		if until.Before(time.Now().Add(Retention-time.Second)) || until.After(time.Now().Add(Retention)) {
			f.t.Errorf("retention: %v", until)
		}
	}, result: result})
	return result
}
func TestLifecycleOrphanGateFailureAndRestart(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	r.ReservedBytes = 6
	r.OutstandingBytes = 6
	p := f.permit(r)
	r.Version++
	n, _ := filestorage.NewTransferNamespace(r.ID)
	objectID := uuid.NewString()
	if _, err := f.files.PutTransfer(p.Context, n, objectID, strings.NewReader("orphan")); err != nil {
		t.Fatal(err)
	}
	pending := f.expectCleanup(r)
	if _, err := f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Context.Done():
	case <-time.After(time.Second):
		t.Fatal("cleanup did not cancel writer")
	}
	stats := store.PrivateTransferStats{ReservedBytes: 6, CleanupPending: 1}
	f.expectSweep([]model.PrivateTransfer{pending}, stats)
	f.expect(get(pending))
	if err := f.lifecycle.Maintain(t.Context()); err == nil {
		t.Fatal("held gate reclaimed")
	}
	if object, err := f.files.OpenTransfer(t.Context(), n, objectID); err != nil {
		t.Fatal("orphan removed with permit held")
	} else {
		object.Body.Close()
	}
	p.Close()
	sentinel := errors.New("disk cleanup failed")
	failed, err := New(f.db, f.files, failingRemoval{f.files, sentinel}, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.expectSweep([]model.PrivateTransfer{pending}, stats)
	f.expect(get(pending))
	if err := failed.Maintain(t.Context()); !errors.Is(err, sentinel) {
		t.Fatalf("cleanup failure: %v", err)
	}
	failed.Close(t.Context())
	restarted, err := New(f.db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close(context.Background())
	f.expectSweep([]model.PrivateTransfer{pending}, store.PrivateTransferStats{})
	f.expect(get(pending))
	closed := f.expectClose(pending)
	if err := restarted.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.expect(get(closed), auth(f.actor, closed, nil))
	got, err := restarted.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || got.State != "closed" || got.ReservedBytes != 0 {
		t.Fatalf("closed: %+v %v", got, err)
	}
	if object, err := f.files.OpenTransfer(t.Context(), n, objectID); err == nil {
		object.Body.Close()
		t.Fatal("orphan remains")
	}
}
func TestLifecycleShutdownCancelsAndWaitsForPermit(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	p := f.permit(r)
	r.Version++
	f.expectSweep(nil, store.PrivateTransferStats{})
	done := make(chan struct{}, 1)
	f.lifecycle.SetLogger(slog.New(slog.NewJSONHandler(sweepLogWriter{done}, nil)))
	if err := f.lifecycle.Start(nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("startup sweep not drained")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if err := f.lifecycle.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close should wait: %v", err)
	}
	select {
	case <-p.Context.Done():
	default:
		t.Fatal("permit not canceled")
	}
	p.Close()
	if err := f.lifecycle.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID); err == nil || !strings.Contains(err.Error(), "lifecycle stopped") {
		t.Fatalf("lookup after stop: %v", err)
	}
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID); err == nil {
		t.Fatal("admitted after shutdown")
	}
}
func TestLifecycleActivePermitRenewsIdleDeadline(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	before := time.Now().Add(5 * time.Minute)
	r.ExpiresAt = before
	renewed := cloneTransfer(r)
	renewed.Version++
	renewed.ExpiresAt = time.Now().Add(time.Hour)
	f.expect(get(r), auth(f.actor, r, nil), get(r), daoStep{method: "Put", check: checkTransfer(t, r, true), result: renewed})
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	f.expect(get(renewed), auth(f.actor, renewed, nil))
	updated, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || !updated.ExpiresAt.After(before.Add(30*time.Minute)) || updated.ExpiresAt.After(updated.HardExpiresAt) {
		t.Fatalf("bounded renewal: %+v %v", updated, err)
	}
}
func TestLifecyclePendingCommitRecordsOnlyOriginalOperation(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	p := f.permit(r)
	r.Version++
	op := uuid.NewString()
	r.State = "committing"
	r.Version++
	r.Data = json.RawMessage(`{"operationId":"` + op + `"}`)
	lease := time.Now().Add(45 * time.Second)
	r.LeaseUntil = &lease
	pending := f.expectCleanup(r)
	if _, err := f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	r = pending
	f.expect(get(r))
	if _, err := f.lifecycle.CompletePending(t.Context(), p, f.actor, r.ID, r.Version, "committed", json.RawMessage(`{"operationId":"`+uuid.NewString()+`","receipt":"different"}`)); err == nil {
		t.Fatal("different operation accepted")
	}
	facts := json.RawMessage(`{"operationId":"` + op + `","receipt":"confirmed"}`)
	result := cloneTransfer(r)
	from := "committed"
	result.CleanupFromState = &from
	result.Data = append(json.RawMessage(nil), facts...)
	result.Version++
	expected := cloneTransfer(result)
	expected.Version = r.Version
	f.expect(get(r), get(r), put(expected, r.Version, result, nil))
	got, err := f.lifecycle.CompletePending(t.Context(), p, f.actor, r.ID, r.Version, "committed", facts)
	if err != nil || got.State != "cleanup_pending" || got.CleanupFromState == nil || *got.CleanupFromState != "committed" || transfer.OperationID(got.Data) != op {
		t.Fatalf("late completion: %+v %v", got, err)
	}
	p.Close()
	if _, err := f.lifecycle.CompletePending(t.Context(), p, f.actor, r.ID, r.Version, "committed", facts); err == nil {
		t.Fatal("completion after release")
	}
}
func TestLifecyclePublishedReceiptAndReservationAreAtomic(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	r.ReservedBytes = 8
	r.OutstandingBytes = 8
	p := f.permit(r)
	r.Version++
	n, _ := filestorage.NewTransferNamespace(r.ID)
	if _, err := f.files.PutTransfer(p.Context, n, uuid.NewString(), strings.NewReader("12345678")); err != nil {
		t.Fatal(err)
	}
	consumed := cloneTransfer(r)
	consumed.OutstandingBytes = 0
	consumed.Version++
	failure := errors.New("receipt failure")
	for _, accepted := range []bool{false, true} {
		data := json.RawMessage(`{"receipt":"fail"}`)
		var writeErr error = failure
		if accepted {
			data = json.RawMessage(`{"receipt":"accepted"}`)
			writeErr = nil
		}
		next := cloneTransfer(consumed)
		next.Data = append(json.RawMessage(nil), data...)
		result := cloneTransfer(next)
		result.Version++
		steps := []daoStep{get(r), auth(f.actor, r, nil), get(r), method("LockLedger", nil, nil), method("SubtractOutstanding", consumed, nil, r.ID, int64(8)), get(consumed), {method: "Put", check: checkTransfer(t, next, true), result: result, err: writeErr}}
		outcome := store.TransactionCommitted
		if !accepted {
			outcome = store.TransactionNotCommitted
		}
		plan := f.db.expect(store.Completion{Outcome: outcome}, nil, steps...)
		plan.callbackCheck = func(callbackErr error) {
			if accepted && callbackErr != nil {
				t.Errorf("publication callback: %v", callbackErr)
			}
			if !accepted && !errors.Is(callbackErr, failure) {
				t.Errorf("publication callback lost receipt error: %v", callbackErr)
			}
		}
		got, err := f.lifecycle.TransitionPublished(t.Context(), p, f.actor, r.ID, r.Version, "receiving", data, nil, 8)
		if !accepted {
			if !errors.Is(err, failure) || got.ID != "" {
				t.Fatalf("receipt failure: %+v %v", got, err)
			}
			f.expect(get(r), auth(f.actor, r, nil))
			after, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
			if err != nil || !reflect.DeepEqual(after, r) {
				t.Fatalf("configured unchanged fact: %+v %v", after, err)
			}
		} else if err != nil || got.ReservedBytes != 8 || got.OutstandingBytes != 0 || !strings.Contains(string(got.Data), "accepted") {
			t.Fatalf("receipt: %+v %v", got, err)
		}
	}
}
func TestLifecycleBlockedAuthorizationDoesNotStarveOtherUser(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	other := cloneTransfer(r)
	other.ID = uuid.NewString()
	other.UserID = uuid.NewString()
	other.AuthorityID = uuid.NewString()
	other.ProjectID = uuid.NewString()
	other.TaskID = uuid.NewString()
	a := f.actor
	a.Principal.UserID = other.UserID
	a.Principal.CredentialID = other.AuthorityID
	a.AuthorityID = other.AuthorityID
	entered, release := make(chan struct{}), make(chan struct{})
	blocked := auth(f.actor, r, nil)
	blocked.check = func([]any) { close(entered); <-release }
	f.expect(get(r), blocked)
	result := make(chan error, 1)
	go func() { _, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID); result <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("authorization did not block")
	}
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	f.expect(get(other), auth(a, other, nil))
	if _, err := f.lifecycle.LookupBound(ctx, a, other.ID); err != nil {
		t.Fatal(err)
	}
	pending := pendingRecord(other, "receiving")
	want := cloneTransfer(pending)
	want.Version = other.Version
	f.expect(get(other), auth(a, other, nil), get(other), daoStep{method: "Put", check: func(args []any) {
		got := args[0].(model.PrivateTransfer)
		got.UpdatedAt = want.UpdatedAt
		if !reflect.DeepEqual(got, want) {
			t.Errorf("cleanup: %+v", got)
		}
	}, result: pending})
	if _, err := f.lifecycle.RequestCleanup(ctx, a, other.ID); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("blocked lookup not drained")
	}
}
func TestLifecycleShutdownAllowsPendingCommitReceiptBeforePermitRelease(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	p := f.permit(r)
	r.Version++
	op := uuid.NewString()
	r.State = "committing"
	r.Version++
	r.Data = json.RawMessage(`{"operationId":"` + op + `"}`)
	lease := time.Now().Add(45 * time.Second)
	r.LeaseUntil = &lease
	other, err := New(f.db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close(context.Background())
	pending := f.expectCleanup(r)
	if _, err := other.RequestCleanup(t.Context(), f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	r = pending
	select {
	case <-p.Context.Done():
		t.Fatal("remote cleanup canceled local permit")
	default:
	}
	closed := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() { closed <- f.lifecycle.Close(ctx) }()
	select {
	case <-p.Context.Done():
	case <-ctx.Done():
		t.Fatal("shutdown did not cancel permit")
	}
	select {
	case err := <-closed:
		t.Fatalf("close passed live permit: %v", err)
	default:
	}
	facts := json.RawMessage(`{"operationId":"` + op + `","receipt":"confirmed"}`)
	result := cloneTransfer(r)
	from := "committed"
	result.CleanupFromState = &from
	result.Data = facts
	result.Version++
	want := cloneTransfer(result)
	want.Version = r.Version
	step := get(r)
	step.ctx = func(ctx context.Context) {
		if ctx.Err() != nil {
			t.Error("completion retained canceled operation context")
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Error("completion lacks bound")
		}
	}
	f.expect(step, get(r), put(want, r.Version, result, nil))
	got, err := f.lifecycle.FinishCommit(p.Context, p, f.actor, r.ID, r.Version, "committed", facts)
	if err != nil || got.CleanupFromState == nil || *got.CleanupFromState != "committed" {
		t.Fatalf("shutdown completion: %+v %v", got, err)
	}
	select {
	case err := <-closed:
		t.Fatalf("close passed receipt before release: %v", err)
	default:
	}
	p.Close()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("close not drained")
	}
}
func TestLifecycleBindingJSONNumbersAreExactAndEquivalent(t *testing.T) {
	f := newFixture(t)
	f.binding.Parameters = json.RawMessage(`{"amount":1000,"large":9007199254740993}`)
	r := f.record()
	same := f.binding
	same.Parameters = json.RawMessage(`{"large":9007199254740993,"amount":1e3}`)
	f.expect(get(r), auth(f.actor, r, nil))
	if _, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, same); err != nil || created {
		t.Fatalf("equivalent binding: %v %v", created, err)
	}
	different := f.binding
	different.Parameters = json.RawMessage(`{"amount":1e3,"large":9007199254740992}`)
	f.expect(get(r))
	if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, different); err == nil {
		t.Fatal("distinct integer accepted")
	}
}

func TestLifecycleMaintenanceLogsSafeFacts(t *testing.T) {
	f := newFixture(t)
	const secret = "sensitive-content-never-log-8f21"
	f.binding.Path = secret
	f.binding.Parameters = json.RawMessage(`{"private":"` + secret + `"}`)
	r := pendingRecord(f.record(), "receiving")
	r.ReservedBytes = 6
	r.OutstandingBytes = 6
	failure := errors.New(secret)
	failed, err := New(f.db, f.files, failingRemoval{f.files, failure}, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer failed.Close(context.Background())
	var output bytes.Buffer
	failed.SetLogger(slog.New(slog.NewJSONHandler(&output, nil)))
	oldest := r.CreatedAt
	f.expectSweep([]model.PrivateTransfer{r}, store.PrivateTransferStats{ReservedBytes: 6, CleanupPending: 1, OldestPendingCreatedAt: &oldest})
	f.expect(get(r))
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
		t.Fatalf("entries: %v", entries)
	}
	if entries[0]["transfer_id"] != r.ID || entries[0]["phase"] != "cleanup" || entries[0]["sweep_id"] == "" || entries[0]["sweep_id"] != entries[1]["sweep_id"] {
		t.Fatalf("correlation: %v", entries)
	}
	if entries[1]["temp_reserved_bytes"] != float64(6) || entries[1]["temp_budget_bytes"] != float64(1<<30) || entries[1]["cleanup_backlog"] != float64(1) || entries[1]["cleanup_oldest"] == nil {
		t.Fatalf("metrics: %v", entries)
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
			r := f.record()
			r.State = state
			r.ReservedBytes = 8
			r.OutstandingBytes = 8
			r.Data = json.RawMessage(`{"operationId":"` + uuid.NewString() + `"}`)
			f.expect(get(r), auth(f.actor, r, nil))
			if _, err := f.lifecycle.Reserve(t.Context(), f.actor, r.ID, 1); !errors.Is(err, ErrState) {
				t.Fatalf("%s reservation: %v", state, err)
			}
			f.expect(get(r), auth(f.actor, r, nil))
			got, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
			if err != nil || !reflect.DeepEqual(got, r) {
				t.Fatalf("terminal record altered: %+v %v", got, err)
			}
		})
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

func TestLifecycleCapacityAndStorageFailures(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	for _, tc := range []struct {
		name           string
		free, reserved int64
		want           error
	}{{"disk reserve", 9, 10, ErrCapacity}, {"insufficient bytes", 12, 10, ErrCapacity}, {"sampling failure", 0, 0, errors.New("disk unavailable")}} {
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
			steps := []daoStep{get(r), auth(f.actor, r, nil), method("LockLedger", nil, nil)}
			if sampling == nil {
				steps = append(steps, method("OutstandingTotal", int64(0), nil))
			}
			f.expect(steps...)
			if _, err := l.Reserve(t.Context(), f.actor, r.ID, 3); !errors.Is(err, tc.want) {
				t.Fatalf("capacity: %v", err)
			}
		})
	}
	l, err := New(f.db, f.files, f.files, 4, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close(context.Background())
	f.expect(get(r), auth(f.actor, r, nil), method("LockLedger", nil, nil), method("OutstandingTotal", int64(0), nil), get(r), method("LockLedger", nil, nil), method("ReservedTotal", int64(0), nil))
	if _, err := l.Reserve(t.Context(), f.actor, r.ID, 5); err == nil {
		t.Fatal("budget exceeded")
	}
	f.expect(get(r), auth(f.actor, r, nil))
	got, err := f.lifecycle.LookupBound(t.Context(), f.actor, r.ID)
	if err != nil || !reflect.DeepEqual(got, r) {
		t.Fatalf("reservation failed fact: %+v %v", got, err)
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
	if _, err := f.lifecycle.LookupBound(t.Context(), Actor{}, f.binding.ID); err == nil {
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
	for _, raw := range []string{`{} {}`, `{`} {
		binding.Parameters = json.RawMessage(raw)
		if _, _, err := f.lifecycle.OpenRecord(t.Context(), f.actor, binding); err == nil {
			t.Fatalf("invalid JSON accepted: %s", raw)
		}
	}
	if _, err := f.lifecycle.Reserve(t.Context(), f.actor, f.binding.ID, -1); err == nil {
		t.Fatal("negative reserve")
	}
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, "bad"); err == nil {
		t.Fatal("bad permit ID")
	}
	r := f.record()
	for _, tc := range []struct {
		version int64
		state   string
		data    json.RawMessage
	}{{r.Version, "readable", json.RawMessage(`{}`)}, {r.Version + 1, "receiving", json.RawMessage(`{}`)}, {r.Version, "committing", json.RawMessage(`{}`)}} {
		f.expect(get(r), auth(f.actor, r, nil))
		if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, tc.version, tc.state, tc.data, nil); err == nil {
			t.Fatalf("invalid transition: %+v", tc)
		}
	}
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "receiving", json.RawMessage(`{`), nil); err == nil {
		t.Fatal("malformed receipt accepted")
	}
	if _, err := f.lifecycle.TransitionPublished(t.Context(), nil, f.actor, r.ID, r.Version, "receiving", json.RawMessage(`{}`), nil, 0); err == nil {
		t.Fatal("publication without permit")
	}
	if _, err := f.lifecycle.FinishCommit(t.Context(), nil, f.actor, r.ID, r.Version, "committed", json.RawMessage(`{}`)); err == nil {
		t.Fatal("completion without permit")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := f.lifecycle.AcquirePermit(ctx, f.actor, r.ID); err == nil {
		t.Fatal("canceled permit admitted")
	}
	if _, err := f.lifecycle.RequestCleanup(t.Context(), Actor{}, r.ID); err == nil {
		t.Fatal("cleanup without actor")
	}
}
func TestLifecycleExpiredLeaseAndIdleRecovery(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	f.expect(get(r))
	got, err := f.lifecycle.markDue(t.Context(), r.ID, time.Now())
	if err != nil || got.State != "receiving" {
		t.Fatalf("live: %+v %v", got, err)
	}
	r.State = "committing"
	r.Data = json.RawMessage(`{"operationId":"` + uuid.NewString() + `"}`)
	lease := time.Now().Add(45 * time.Second)
	r.LeaseUntil = &lease
	f.expect(get(r))
	if got, err := f.lifecycle.markDue(t.Context(), r.ID, time.Now()); err != nil || got.State != "committing" {
		t.Fatalf("live lease: %+v %v", got, err)
	}
	expired := time.Now().Add(-time.Second)
	r.LeaseUntil = &expired
	unknown := cloneTransfer(r)
	unknown.State = "unknown"
	unknown.LeaseUntil = nil
	unknown.Version++
	pending := pendingRecord(unknown, "unknown")
	first := cloneTransfer(unknown)
	first.Version = r.Version
	second := cloneTransfer(pending)
	second.Version = unknown.Version
	f.expect(get(r), get(r), put(first, r.Version, unknown, nil), get(unknown), daoStep{method: "Put", check: func(args []any) {
		v := args[0].(model.PrivateTransfer)
		v.UpdatedAt = second.UpdatedAt
		if !reflect.DeepEqual(v, second) || args[1] != unknown.Version {
			t.Errorf("pending: %+v", args)
		}
	}, result: pending})
	got, err = f.lifecycle.markDue(t.Context(), r.ID, time.Now())
	if err != nil || got.State != "cleanup_pending" || got.CleanupFromState == nil || *got.CleanupFromState != "unknown" {
		t.Fatalf("expired lease: %+v %v", got, err)
	}
	f.expect(get(pending))
	if _, err := f.lifecycle.markDue(t.Context(), r.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	f.expectSweep([]model.PrivateTransfer{pending}, store.PrivateTransferStats{})
	f.expect(get(pending))
	closed := f.expectClose(pending)
	if err := f.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.expect(get(closed))
	if got, err := f.lifecycle.markDue(t.Context(), r.ID, time.Now()); err != nil || got.State != "closed" {
		t.Fatalf("closed: %+v %v", got, err)
	}
	idle := f.record()
	idle.ID = uuid.NewString()
	idle.ExpiresAt = expired
	idlePending := pendingRecord(idle, "receiving")
	want := cloneTransfer(idlePending)
	want.Version = idle.Version
	f.expect(get(idle), get(idle), daoStep{method: "Put", check: func(args []any) {
		v := args[0].(model.PrivateTransfer)
		v.UpdatedAt = want.UpdatedAt
		if !reflect.DeepEqual(v, want) {
			t.Errorf("idle cleanup: %+v", v)
		}
	}, result: idlePending})
	if got, err := f.lifecycle.markDue(t.Context(), idle.ID, time.Now()); err != nil || got.State != "cleanup_pending" {
		t.Fatalf("idle: %+v %v", got, err)
	}
}
func TestLifecycleUnconfirmedTransaction(t *testing.T) {
	f := newFixture(t)
	failure := errors.New("storage failed")
	for _, tc := range []struct {
		name string
		c    store.Completion
		err  error
	}{{"unknown", store.Completion{Outcome: store.TransactionUnknown}, nil}, {"failure", store.Completion{Outcome: store.TransactionNotCommitted}, failure}} {
		t.Run(tc.name, func(t *testing.T) {
			r := f.record()
			plan := f.db.expect(tc.c, tc.err, get(r), auth(f.actor, r, nil))
			plan.callbackCheck = func(callbackErr error) {
				if callbackErr != nil {
					t.Errorf("successful lookup callback: %v", callbackErr)
				}
			}
			got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
			if err == nil || !reflect.DeepEqual(got, model.PrivateTransfer{}) || created {
				t.Fatalf("unconfirmed success: %+v %v %v", got, created, err)
			}
			if tc.err != nil && !errors.Is(err, failure) {
				t.Fatalf("completion chain: %v", err)
			}
			if tc.err == nil {
				var te *store.TransactionError
				if !errors.As(err, &te) || te.Outcome != store.TransactionUnknown {
					t.Fatalf("unknown facts: %v", err)
				}
			}
		})
	}
}
func TestLifecycleDownloadStateAndPermitFences(t *testing.T) {
	f := newFixture(t)
	f.binding.Direction = "download"
	r := f.record()
	if r.State != "preparing" {
		t.Fatalf("initial: %s", r.State)
	}
	f.expect(get(r), auth(f.actor, r, nil))
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "committing", json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("download commit accepted")
	}
	readable := cloneTransfer(r)
	readable.State = "readable"
	readable.Data = json.RawMessage(`{"size":8}`)
	readable.Version++
	want := cloneTransfer(readable)
	want.Version = r.Version
	f.expect(get(r), auth(f.actor, r, nil), get(r), daoStep{method: "Put", check: checkTransfer(t, want, true), result: readable})
	if _, err := f.lifecycle.Transition(t.Context(), f.actor, r.ID, r.Version, "readable", json.RawMessage(`{"size":8}`), nil); err != nil {
		t.Fatal(err)
	}
	p := f.permit(readable)
	readable.Version++
	for _, tc := range []struct {
		id string
		n  int64
	}{{uuid.NewString(), 1}, {r.ID, -1}} {
		if _, err := f.lifecycle.TransitionPublished(t.Context(), p, f.actor, tc.id, readable.Version, "readable", json.RawMessage(`{}`), nil, tc.n); err == nil {
			t.Fatal("bad publication accepted")
		}
	}
	f.expect(get(readable))
	if _, err := f.lifecycle.FinishCommit(t.Context(), p, f.actor, r.ID, readable.Version, "committed", json.RawMessage(`{}`)); err == nil {
		t.Fatal("download commit completion accepted")
	}
	p.Close()
	if _, err := f.lifecycle.TransitionPublished(t.Context(), p, f.actor, r.ID, readable.Version, "readable", json.RawMessage(`{}`), nil, 0); err == nil {
		t.Fatal("closed permit accepted")
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
	r := f.record()
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
			p.Close()
		}
		result <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("gate not entered")
	}
	f.expect(get(r), auth(f.actor, r, model.ErrNotFound))
	gate.Close()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("revoked actor admitted after gate wait")
		}
	case <-ctx.Done():
		t.Fatal("permit not drained")
	}
	probe, err := f.files.AcquireGate(ctx, filestorage.PrivateGate, r.ID)
	if err != nil {
		t.Fatalf("gate leaked: %v", err)
	}
	probe.Close()
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
	entered, release chan struct{}
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
	r := f.record()
	failure := errors.New("gate unavailable")
	l, err := New(f.db, failedGate{f.files, failure}, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.AcquirePermit(t.Context(), f.actor, r.ID); !errors.Is(err, failure) {
		t.Fatalf("gate: %v", err)
	}
	l.Close(t.Context())
	entered, release := make(chan struct{}), make(chan struct{})
	late, err := New(f.db, lateGate{f.files, entered, release}, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancelCleanup()
		if err := late.Close(cleanupCtx); err != nil {
			t.Error(err)
		}
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		p, err := late.AcquirePermit(ctx, f.actor, r.ID)
		if p != nil {
			p.Close()
		}
		result <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("gate not acquired")
	}
	closed := make(chan error, 1)
	go func() { closed <- late.Close(ctx) }()
	select {
	case <-late.ctx.Done():
	case <-ctx.Done():
		t.Fatal("shutdown not started")
	}
	close(release)
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("late permit admitted")
		}
	case <-ctx.Done():
		t.Fatal("permit not drained")
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("shutdown not joined")
	}
	probe, err := f.files.AcquireGate(ctx, filestorage.PrivateGate, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	probe.Close()
}
func TestLifecyclePermitRejectsTerminalAndCapsRenewal(t *testing.T) {
	f := newFixture(t)
	r := f.record()
	r.ExpiresAt = time.Now().Add(10 * time.Second)
	r.HardExpiresAt = time.Now().Add(30 * time.Second)
	renewed := cloneTransfer(r)
	renewed.ExpiresAt = r.HardExpiresAt
	renewed.Version++
	f.expect(get(r), auth(f.actor, r, nil), get(r), daoStep{method: "Put", check: checkTransfer(t, renewedRecordVersion(r, renewed), true), result: renewed})
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	p.Close()
	pending := pendingRecord(renewed, "receiving")
	f.expect(get(pending), auth(f.actor, pending, nil))
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID); err == nil {
		t.Fatal("pending admitted")
	}
	id := uuid.NewString()
	f.expect(getMissing(id))
	if _, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, id); err == nil {
		t.Fatal("missing transfer admitted")
	}
}
func renewedRecordVersion(original, result model.PrivateTransfer) model.PrivateTransfer {
	result.Version = original.Version
	return result
}

func TestLifecycleCreateWiring(t *testing.T) {
	f := newFixture(t)
	l, err := New(f.db, f.files, f.files, 123, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close(context.Background())
	if reflect.ValueOf(l.createRecord).Pointer() != reflect.ValueOf(transfer.Create).Pointer() || l.db != f.db || l.files != f.files || l.private != f.files || l.budget != 123 || l.reservedFree != 4 {
		t.Fatal("constructor dependencies or Create binding changed")
	}
}

func TestLifecycleCreateCoordination(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		f := newFixture(t)
		r := f.record()
		ctx := context.WithValue(t.Context(), struct{}{}, "original")
		plan := f.db.expect(store.Completion{Outcome: store.TransactionCommitted}, nil,
			getMissing(r.ID), auth(f.actor, r, nil), daoStep{
				method: "Create", check: checkInitialRecord(t, r), result: insertFact{cloneTransfer(r), true},
				ctx: func(actual context.Context) {
					if actual != ctx {
						t.Error("Create did not receive the original context")
					}
				},
			})
		plan.callbackCheck = func(err error) {
			if err != nil {
				t.Errorf("callback: %v", err)
			}
		}
		got, created, err := f.lifecycle.OpenRecord(ctx, f.actor, f.binding)
		if err != nil || !created || !reflect.DeepEqual(got, r) {
			t.Fatalf("open: %+v created=%v error=%v", got, created, err)
		}
	})

	t.Run("lookup and authorization failures", func(t *testing.T) {
		f := newFixture(t)
		r := f.record()
		lookupFailure := errors.New("lookup failed")
		f.expect(daoStep{method: "Get", key: r.ID, args: []any{r.ID}, err: lookupFailure})
		got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
		if !errors.Is(err, lookupFailure) || !reflect.DeepEqual(got, model.PrivateTransfer{}) || created {
			t.Fatalf("lookup: %+v created=%v error=%v", got, created, err)
		}
		authFailure := errors.New("authorization failed")
		f.expect(getMissing(r.ID), auth(f.actor, r, authFailure))
		got, created, err = f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
		if !errors.Is(err, authFailure) || !reflect.DeepEqual(got, model.PrivateTransfer{}) || created {
			t.Fatalf("authorization: %+v created=%v error=%v", got, created, err)
		}
	})

	t.Run("Create failures", func(t *testing.T) {
		f := newFixture(t)
		r := f.record()
		failure := errors.New("Create failed")
		for _, supplied := range []error{transfer.ErrCapacity, failure} {
			f.expect(getMissing(r.ID), auth(f.actor, r, nil), daoStep{method: "Create", check: checkInitialRecord(t, r), result: insertFact{cloneTransfer(r), true}, err: supplied})
			got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
			if !errors.Is(err, supplied) || !reflect.DeepEqual(got, model.PrivateTransfer{}) || created {
				t.Fatalf("Create refusal: %+v created=%v error=%v", got, created, err)
			}
		}
	})

	t.Run("callback and cleanup failures retain both causes", func(t *testing.T) {
		f := newFixture(t)
		r := f.record()
		operationFailure := errors.New("operation failed")
		cleanupFailure := errors.New("cleanup failed")
		plan := f.db.expect(store.Completion{Outcome: store.TransactionNotCommitted}, cleanupFailure,
			getMissing(r.ID), auth(f.actor, r, nil), daoStep{method: "Create", check: checkInitialRecord(t, r), result: insertFact{cloneTransfer(r), true}, err: operationFailure})
		plan.callbackCheck = func(err error) {
			if !errors.Is(err, operationFailure) {
				t.Errorf("callback failure: %v", err)
			}
		}
		got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
		if !errors.Is(err, operationFailure) || !errors.Is(err, cleanupFailure) || !reflect.DeepEqual(got, model.PrivateTransfer{}) || created {
			t.Fatalf("callback and cleanup: %+v created=%v error=%v", got, created, err)
		}
	})

	t.Run("returned binding is rechecked", func(t *testing.T) {
		f := newFixture(t)
		r := f.record()
		other := cloneTransfer(r)
		other.Path = "different"
		f.expect(getMissing(r.ID), auth(f.actor, r, nil), daoStep{method: "Create", check: checkInitialRecord(t, r), result: insertFact{other, true}})
		got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
		if !errors.Is(err, ErrConflict) || !reflect.DeepEqual(got, model.PrivateTransfer{}) || created {
			t.Fatalf("returned binding: %+v created=%v error=%v", got, created, err)
		}
	})

	t.Run("completion suppresses Create result", func(t *testing.T) {
		f := newFixture(t)
		r := f.record()
		cleanupFailure := errors.New("cleanup failed")
		for _, tc := range []struct {
			name       string
			completion store.Completion
			err        error
		}{
			{"unknown", store.Completion{Outcome: store.TransactionUnknown}, nil},
			{"not committed", store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("storage failed")},
			{"cleanup", store.Completion{Outcome: store.TransactionCommitted}, cleanupFailure},
		} {
			t.Run(tc.name, func(t *testing.T) {
				plan := f.db.expect(tc.completion, tc.err, getMissing(r.ID), auth(f.actor, r, nil), daoStep{method: "Create", check: checkInitialRecord(t, r), result: insertFact{cloneTransfer(r), true}})
				plan.callbackCheck = func(err error) {
					if err != nil {
						t.Errorf("successful Create callback: %v", err)
					}
				}
				got, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, f.binding)
				if err == nil || !reflect.DeepEqual(got, model.PrivateTransfer{}) || created || tc.err != nil && !errors.Is(err, tc.err) {
					t.Fatalf("completion: %+v created=%v error=%v", got, created, err)
				}
				if tc.completion.Outcome == store.TransactionUnknown {
					var transaction *store.TransactionError
					if !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown {
						t.Fatalf("unknown completion: %v", err)
					}
				}
			})
		}
	})
}
