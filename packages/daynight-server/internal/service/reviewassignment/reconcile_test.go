package reviewassignment

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const project = "00000000-0000-4000-8000-000000000001"
const account = "00000000-0000-4000-8000-000000000002"
const workerID = "00000000-0000-4000-8000-000000000003"

var now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
var target = []byte(`{"projects":[{"projectId":"` + project + `","nativeOverrides":{}}]}`)

type fixture struct {
	store.ReviewAssignmentStore
	t          *testing.T
	calls      []string
	worker     store.ReviewWorker
	prs        []store.ReviewPR
	writes     []int64
	failNumber int64
	completion store.Completion
	tx         *transaction
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{t: t, worker: store.ReviewWorker{ReviewWorkerKey: store.ReviewWorkerKey{UserID: account, WorkerID: workerID}, LastSeenAt: now, ReviewEnabled: true, DesiredConfiguration: target}, completion: store.Completion{Outcome: store.TransactionCommitted}}
	f.tx = &transaction{t: t, current: f.worker, repo: 42, branch: "main", now: now, pr: store.ReviewPR{Number: 1, GitHubID: 11, State: "open", BaseRef: "main"}}
	return f
}
func (f *fixture) ReviewScanStart(context.Context) (time.Time, *store.ReviewWorkerKey, error) {
	f.calls = append(f.calls, "start")
	key := f.worker.ReviewWorkerKey
	return now, &key, nil
}
func (f *fixture) ReviewWorkers(_ context.Context, start time.Time, upper store.ReviewWorkerKey, after *store.ReviewWorkerKey, limit int) ([]store.ReviewWorker, error) {
	f.calls = append(f.calls, "workers")
	if start != now || upper != f.worker.ReviewWorkerKey || limit != pageSize {
		f.t.Fatal("incorrect worker scan")
	}
	if after != nil {
		return nil, nil
	}
	return []store.ReviewWorker{f.worker}, nil
}
func (f *fixture) ReviewRepository(_ context.Context, id string) (*int64, error) {
	f.calls = append(f.calls, "repository")
	if id != project {
		f.t.Fatal(id)
	}
	n := int64(42)
	return &n, nil
}
func (f *fixture) ReviewOpenPRs(_ context.Context, user, id string, repo int64, upper, after *int64, limit int) ([]store.ReviewPR, error) {
	f.calls = append(f.calls, "prs")
	if user != account || id != project || repo != 42 || limit != pageSize {
		f.t.Fatal("incorrect PR scan")
	}
	if after == nil {
		return append([]store.ReviewPR(nil), f.prs...), nil
	}
	return nil, nil
}
func (f *fixture) WriteReviewAssignment(ctx context.Context, id string, fn func(store.ReviewAssignmentWrite) error) (store.Completion, error) {
	if id != project {
		f.t.Fatal(id)
	}
	f.calls = append(f.calls, "write")
	f.tx.calls = nil
	if f.tx.pr.Number == f.failNumber {
		return store.Completion{Outcome: store.TransactionUnknown}, errors.New("uncertain")
	}
	err := fn(f.tx)
	return f.completion, err
}

type transaction struct {
	t                                                       *testing.T
	calls                                                   []string
	current                                                 store.ReviewWorker
	repo                                                    int64
	branch                                                  string
	unknownBranch                                           bool
	now                                                     time.Time
	pr                                                      store.ReviewPR
	authErr, connErr, workerErr, clockErr, prErr, insertErr error
	inserted                                                bool
}

func (x *transaction) LockAuthorization(_ context.Context, user string) (model.ProjectAccess, error) {
	x.calls = append(x.calls, "auth")
	if user != account {
		x.t.Fatal(user)
	}
	return model.ProjectAccess{}, x.authErr
}
func (x *transaction) LockConnection(context.Context) (*store.ReviewConnection, error) {
	x.calls = append(x.calls, "connection")
	if x.connErr != nil {
		return nil, x.connErr
	}
	if x.unknownBranch {
		return &store.ReviewConnection{RepositoryID: &x.repo}, nil
	}
	return &store.ReviewConnection{RepositoryID: &x.repo, DefaultBranch: &x.branch}, nil
}
func (x *transaction) LockWorker(_ context.Context, user, id string) (store.ReviewWorker, error) {
	x.calls = append(x.calls, "worker")
	if user != account || id != workerID {
		x.t.Fatal("worker identity")
	}
	return x.current, x.workerErr
}
func (x *transaction) ObservedAt(context.Context) (time.Time, error) {
	x.calls = append(x.calls, "clock")
	return x.now, x.clockErr
}
func (x *transaction) PullRequest(_ context.Context, repo, number int64) (*store.ReviewPR, error) {
	x.calls = append(x.calls, "pr")
	if repo != 42 || number != 1 {
		x.t.Fatal("PR identity")
	}
	if x.prErr != nil {
		return nil, x.prErr
	}
	return &x.pr, nil
}
func (x *transaction) Insert(_ context.Context, user string, repo, id int64, w string, at time.Time) (bool, error) {
	x.calls = append(x.calls, "insert")
	if user != account || repo != 42 || id != 11 || w != workerID || at != now {
		x.t.Fatal("insert identity")
	}
	x.inserted = true
	return true, x.insertErr
}

func TestAssignmentRevalidatesLockedFacts(t *testing.T) {
	cause := errors.New("storage error")
	cases := []struct {
		name     string
		change   func(*transaction)
		want     []string
		inserted bool
		err      error
	}{
		{"eligible", func(*transaction) {}, []string{"auth", "connection", "worker", "clock", "pr", "insert"}, true, nil},
		{"revoked", func(x *transaction) { x.authErr = model.ErrNotFound }, []string{"auth"}, false, nil},
		{"auth error", func(x *transaction) { x.authErr = cause }, []string{"auth"}, false, cause},
		{"connection error", func(x *transaction) { x.connErr = cause }, []string{"auth", "connection"}, false, cause},
		{"repository changed", func(x *transaction) { x.repo = 99 }, []string{"auth", "connection"}, false, nil},
		{"unknown branch", func(x *transaction) { x.unknownBranch = true }, []string{"auth", "connection"}, false, nil},
		{"changed default branch", func(x *transaction) { x.branch = "trunk" }, []string{"auth", "connection", "worker", "clock", "pr"}, false, nil},
		{"changed base", func(x *transaction) { x.pr.BaseRef = "release" }, []string{"auth", "connection", "worker", "clock", "pr"}, false, nil},
		{"worker missing", func(x *transaction) { x.workerErr = model.ErrNotFound }, []string{"auth", "connection", "worker"}, false, nil},
		{"worker error", func(x *transaction) { x.workerErr = cause }, []string{"auth", "connection", "worker"}, false, cause},
		{"clock error", func(x *transaction) { x.clockErr = cause }, []string{"auth", "connection", "worker", "clock"}, false, cause},
		{"disabled", func(x *transaction) { x.current.ReviewEnabled = false }, []string{"auth", "connection", "worker", "clock"}, false, nil},
		{"expired boundary", func(x *transaction) { x.current.LastSeenAt = now.Add(-120 * time.Second) }, []string{"auth", "connection", "worker", "clock"}, false, nil},
		{"future report", func(x *transaction) { x.current.LastSeenAt = now.Add(time.Nanosecond) }, []string{"auth", "connection", "worker", "clock"}, false, nil},
		{"uncovered", func(x *transaction) { x.current.DesiredConfiguration = nil }, []string{"auth", "connection", "worker", "clock"}, false, nil},
		{"PR error", func(x *transaction) { x.prErr = cause }, []string{"auth", "connection", "worker", "clock", "pr"}, false, cause},
		{"closed", func(x *transaction) { x.pr.State = "closed" }, []string{"auth", "connection", "worker", "clock", "pr"}, false, nil},
		{"replaced", func(x *transaction) { x.pr.GitHubID = 22 }, []string{"auth", "connection", "worker", "clock", "pr"}, false, nil},
		{"insert error", func(x *transaction) { x.insertErr = cause }, []string{"auth", "connection", "worker", "clock", "pr", "insert"}, true, cause},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			tc.change(f.tx)
			r := New(f, nil)
			_, err := r.assign(t.Context(), f.worker, project, 42, store.ReviewPR{Number: 1, GitHubID: 11})
			if !errors.Is(err, tc.err) || !reflect.DeepEqual(f.tx.calls, tc.want) || f.tx.inserted != tc.inserted {
				t.Fatalf("calls %v inserted %v err %v", f.tx.calls, f.tx.inserted, err)
			}
		})
	}
}

func TestBatchContinuesInsidePageAndAfterUnknown(t *testing.T) {
	f := newFixture(t)
	f.prs = []store.ReviewPR{{Number: 3, GitHubID: 33, Assigned: true}, {Number: 2, GitHubID: 22}, {Number: 1, GitHubID: 11}}
	f.failNumber = 1
	// Test failure without making a claim about whether it committed.
	var logs bytes.Buffer
	r := New(f, slog.New(slog.NewJSONHandler(&logs, nil)))
	for i := 0; i < 4; i++ {
		r.Batch(t.Context(), 1)
	}
	if got := strings.Join(f.calls, ","); got != "start,workers,repository,prs" {
		t.Fatalf("before attempts: %s", got)
	}
	// Use a controlled unknown outcome for PR 2, then process PR 1 next batch.
	f.failNumber = 2
	f.tx.pr.Number = 2
	r.Batch(t.Context(), 1)
	f.tx.pr = store.ReviewPR{Number: 1, GitHubID: 11, State: "open", BaseRef: "main"}
	r.Batch(t.Context(), 1)
	if !f.tx.inserted || !strings.Contains(logs.String(), `"outcome":"unknown"`) || !strings.Contains(logs.String(), `"number":2`) {
		t.Fatalf("insert %v logs %s", f.tx.inserted, logs.String())
	}
}

func TestCancelledBatchAndEmptyPass(t *testing.T) {
	f := newFixture(t)
	r := New(f, nil)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	r.Batch(ctx, 2)
	if len(f.calls) != 0 {
		t.Fatal(f.calls)
	}
	f.worker.DesiredConfiguration = nil
	r.Batch(t.Context(), 10)
	if fmt.Sprint(f.calls) != "[start workers workers]" {
		t.Fatal(f.calls)
	}
}
