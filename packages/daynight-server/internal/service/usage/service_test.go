package usage

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

type controlledStore struct {
	read  func(context.Context, func(store.UsageScope) error) error
	write func(context.Context, func(store.UsageScope) error) (store.Completion, error)
}

func newTestService(t *testing.T, db store.UsageStore, options Options) *Service {
	t.Helper()
	if len(options.CursorKey) == 0 {
		options.CursorKey = []byte(strings.Repeat("k", 32))
	}
	s, err := New(db, options)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (s controlledStore) ReadUsage(ctx context.Context, f func(store.UsageScope) error) error {
	return s.read(ctx, f)
}
func (s controlledStore) WriteUsage(ctx context.Context, f func(store.UsageScope) error) (store.Completion, error) {
	return s.write(ctx, f)
}
func code(t *testing.T, err error, want string) {
	t.Helper()
	var f *model.UsageFault
	if !errors.As(err, &f) || f.Code != want {
		t.Fatalf("wanted %s got %v", want, err)
	}
}
func TestUsageWriteCompletionAndFeatureFlag(t *testing.T) {
	cause := errors.New("commit acknowledgement lost")
	ctx := t.Context()
	called := false
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown} {
		s := newTestService(t, controlledStore{write: func(actual context.Context, f func(store.UsageScope) error) (store.Completion, error) {
			if actual != ctx {
				t.Fatal("context")
			}
			if err := f(nil); err != nil {
				t.Fatal(err)
			}
			return store.Completion{Outcome: outcome}, cause
		}}, Options{WriteEnabled: true})
		err := s.write(ctx, func(store.UsageScope) error { called = true; return nil })
		if !errors.Is(err, cause) {
			t.Fatal(err)
		}
		if outcome == store.TransactionUnknown {
			code(t, err, "write_outcome_unknown")
		}
	}
	if !called {
		t.Fatal("callback not executed")
	}
	s := newTestService(t, nil, Options{})
	code(t, s.write(ctx, func(store.UsageScope) error { t.Fatal("disabled write callback"); return nil }), "write_disabled")
	s = newTestService(t, controlledStore{write: func(context.Context, func(store.UsageScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, nil
	}}, Options{WriteEnabled: true})
	code(t, s.write(ctx, func(store.UsageScope) error { return nil }), "write_not_committed")
}
func TestGrantAndCursorBoundaries(t *testing.T) {
	now := time.Now().UTC()
	token, hash, err := mint([32]byte{})
	if err != nil {
		t.Fatal(err)
	}
	end := now.Add(time.Hour)
	r := model.UsageRecord{GrantHash: hash, GrantExpiresAt: &end}
	if err = validateGrant(r, token, now); err != nil {
		t.Fatal(err)
	}
	code(t, validateGrant(r, "wrong", now), "invalid_grant")
	code(t, validateGrant(r, token, end), "upload_expired")
	r.GrantRevokedAt = &now
	code(t, validateGrant(r, token, now), "permission_revoked")
	if got := expiry(now, now.Add(-89*24*time.Hour)); !got.Equal(now.Add(24 * time.Hour)) {
		t.Fatal(got)
	}
	s := newTestService(t, nil, Options{})
	c := cursor{Binding: "principal-filter-permission", Revision: "revision", LastTime: now, LastID: "id", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
	encoded, err := s.encodeCursor(c)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := s.decodeCursor(encoded, now)
	if err != nil || decoded.Binding != c.Binding || !decoded.LastTime.Equal(c.LastTime) {
		t.Fatal(decoded, err)
	}
	_, err = s.decodeCursor(encoded, now.Add(time.Hour))
	code(t, err, "cursor_expired")
	_, err = s.decodeCursor(encoded+"tamper", now)
	code(t, err, "invalid_cursor")
}

type summaryDAO struct {
	store.UsageDAO
	now          time.Time
	metricsCalls int
	tasks        []store.UsageMember
}

func (d *summaryDAO) Now(context.Context) (time.Time, error) { return d.now, nil }
func (d *summaryDAO) PermissionEpoch(context.Context, string, string) (string, error) {
	return "epoch", nil
}
func (d *summaryDAO) ProjectAccess(context.Context, string, string, bool) (model.ProjectAccess, error) {
	return model.ProjectAccess{ProjectID: "project", Role: model.ProjectAdmin, Ownership: model.ProjectOwnership{TeamID: "team", Version: 1}}, nil
}
func (d *summaryDAO) Tasks(context.Context, string, []string) ([]store.UsageMember, error) {
	return d.tasks, nil
}
func (d *summaryDAO) TaskMetrics(_ context.Context, f store.UsageFilter) (map[string]model.UsageSummary, error) {
	d.metricsCalls++
	if len(f.TaskIDs) != 1 {
		panic("unexpected filter")
	}
	return map[string]model.UsageSummary{}, nil
}
func (d *summaryDAO) Executions(context.Context, store.UsageFilter) ([]store.UsageExecution, error) {
	return nil, nil
}

type summarySessionDAO struct{ store.SessionDAO }

func (summarySessionDAO) ReadCredential(context.Context, model.Principal, time.Time) error {
	return nil
}

type summaryScope struct{ dao *summaryDAO }

func (s summaryScope) UsageDAO() store.UsageDAO     { return s.dao }
func (s summaryScope) SessionDAO() store.SessionDAO { return summarySessionDAO{} }
func TestTaskSummaryReauthorizesAndExcludesObservationFromETag(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	dao := &summaryDAO{now: time.Now().UTC(), tasks: []store.UsageMember{{ID: id, Title: "Task"}}}
	reads := 0
	s := newTestService(t, controlledStore{read: func(ctx context.Context, f func(store.UsageScope) error) error { reads++; return f(summaryScope{dao}) }}, Options{})
	first, err := s.TaskSummaries(t.Context(), model.Principal{UserID: "user", CredentialID: "credential"}, "project", []string{id})
	if err != nil {
		t.Fatal(err)
	}
	dao.now = dao.now.Add(time.Second)
	second, err := s.TaskSummaries(t.Context(), model.Principal{UserID: "user", CredentialID: "credential"}, "project", []string{id})
	if err != nil {
		t.Fatal(err)
	}
	if first.ETag != second.ETag || reads != 2 || first.Items[0].Summary.Metrics["totalTokens"].Known != nil || first.Items[0].Summary.Completeness != "no_data" {
		t.Fatal(first, second, reads)
	}
	dao.tasks = nil
	_, err = s.TaskSummaries(t.Context(), model.Principal{}, "project", []string{id})
	code(t, err, "resource_unavailable")
	if dao.metricsCalls != 2 {
		t.Fatal("read statistics before authorizing all Task IDs")
	}
	_, err = s.TaskSummaries(t.Context(), model.Principal{}, "project", []string{id, id})
	code(t, err, "invalid_batch")
	if authorizeTask(store.UsageAuthorization{AllowAgents: true}) != nil {
		t.Fatal("allowed")
	}
	code(t, authorizeTask(store.UsageAuthorization{AllowAgents: true, Paused: true}), "permission_revoked")
	if core.Value(emptySummary().Metrics["totalTokens"].Known) != "" {
		t.Fatal("unknown became zero")
	}
}
