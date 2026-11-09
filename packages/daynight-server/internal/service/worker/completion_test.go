package worker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/google/uuid"
)

type unconfirmedWriter struct{ outcome store.TransactionOutcome }

func (u unconfirmedWriter) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("unexpected read")
}
func (u unconfirmedWriter) WriteWorker(context.Context, func(store.WorkerScope) error) (store.Completion, error) {
	return store.Completion{Outcome: u.outcome}, nil
}

func TestUnconfirmedWorkerWritesDoNotReturnSuccess(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	now := time.Now().UTC()
	code := "unavailable"
	report := model.WorkerReport{Telemetry: model.WorkerTelemetry{
		Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "worker"}, Platform: model.PlatformLinux,
		WorkingDirectory: "/work", SampledAt: now,
		OS:       model.WorkerProbe[model.WorkerOS]{State: "error", CheckedAt: now, Code: &code},
		CPU:      model.WorkerProbe[model.WorkerCPU]{State: "error", CheckedAt: now, Code: &code},
		Memory:   model.WorkerProbe[model.WorkerMemory]{State: "error", CheckedAt: now, Code: &code},
		Disk:     model.WorkerProbe[model.WorkerDisk]{State: "error", CheckedAt: now, Code: &code},
		Versions: model.WorkerVersions{Daynight: "1", Herdr: model.WorkerProbe[string]{State: "error", CheckedAt: now, Code: &code}, Codex: model.WorkerProbe[string]{State: "error", CheckedAt: now, Code: &code}, Copilot: model.WorkerProbe[string]{State: "error", CheckedAt: now, Code: &code}},
	}}
	configuration := model.WorkerConfiguration{MaxConcurrent: 2, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: []model.WorkerProjectConfiguration{}}
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		workers := NewWorkers(unconfirmedWriter{outcome})
		if _, err := workers.Report(context.Background(), principal, id, report); err == nil || !strings.Contains(err.Error(), "transaction did not confirm commit") {
			t.Fatalf("report accepted %s: %v", outcome, err)
		}
		if _, err := workers.PutConfiguration(context.Background(), principal, id, "1", configuration); err == nil || !strings.Contains(err.Error(), "transaction did not confirm commit") {
			t.Fatalf("configuration accepted %s: %v", outcome, err)
		}
	}
}

type listTestStore struct {
	store.WorkerWriter
	items      []store.WorkerSummary
	observed   time.Time
	clockErr   error
	readErr    error
	summaryErr error
}
type listTestScope struct {
	store.SnapshotScope
	source *listTestStore
}
type listTestReader struct {
	store.WorkerReader
	source *listTestStore
}

func (s *listTestStore) ReadSnapshot(_ context.Context, operation func(store.SnapshotScope) error) error {
	if s.readErr != nil {
		return s.readErr
	}
	return operation(listTestScope{source: s})
}
func (s listTestScope) ObservedAt(context.Context) (time.Time, error) {
	return s.source.observed, s.source.clockErr
}
func (s listTestScope) WorkerDAO() store.WorkerReader { return listTestReader{source: s.source} }
func (r listTestReader) WorkerSummaries(_ context.Context, _ string, _ time.Time, page store.Page) (store.WorkerSummaryPage, error) {
	if r.source.summaryErr != nil {
		return store.WorkerSummaryPage{}, r.source.summaryErr
	}
	items := r.source.items
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return store.WorkerSummaryPage{Items: items, HasMore: hasMore}, nil
}

func TestWorkerListReadFailuresAndCountPagination(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	item := store.WorkerSummary{WorkerID: uuid.NewString(), CreatedAt: now, LastReportedAt: now, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}}
	sentinel := errors.New("snapshot unavailable")
	for _, source := range []*listTestStore{{observed: now, readErr: sentinel}, {observed: now, clockErr: sentinel}, {observed: now, summaryErr: sentinel}} {
		if _, err := NewWorkers(source).List(context.Background(), principal, model.PageRequest{Limit: 2}); !errors.Is(err, sentinel) {
			t.Fatalf("read failure: %v", err)
		}
	}
	second := item
	second.WorkerID = uuid.NewString()
	second.CreatedAt = now.Add(time.Second)
	page, err := NewWorkers(&listTestStore{observed: now, items: []store.WorkerSummary{item, second}}).List(context.Background(), principal, model.PageRequest{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].WorkerID != item.WorkerID || page.ObservedAt != now || page.NextCursor == nil {
		t.Fatalf("first page: %+v %v", page, err)
	}
	position, err := workercore.ListPage(model.PageRequest{Limit: 1, Cursor: page.NextCursor}, principal.UserID)
	if err != nil || position.After == nil || position.After.ID != item.WorkerID || !position.After.CreatedAt.Equal(item.CreatedAt) {
		t.Fatalf("continuation: %+v %v", position, err)
	}
	page, err = NewWorkers(&listTestStore{observed: now, items: []store.WorkerSummary{second}}).List(context.Background(), principal, model.PageRequest{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].WorkerID != second.WorkerID || page.NextCursor != nil {
		t.Fatalf("last page: %+v %v", page, err)
	}
	badCursor := item
	badCursor.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := NewWorkers(&listTestStore{observed: now, items: []store.WorkerSummary{badCursor, second}}).List(context.Background(), principal, model.PageRequest{Limit: 1}); err == nil {
		t.Fatal("invalid cursor time accepted")
	}
}
