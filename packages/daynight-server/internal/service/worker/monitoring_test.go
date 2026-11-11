package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
)

const (
	serviceUser     = "10000000-0000-4000-8000-000000000001"
	serviceWorker   = "10000000-0000-4000-8000-000000000002"
	serviceWorker2  = "10000000-0000-4000-8000-000000000003"
	serviceProject  = "10000000-0000-4000-8000-000000000004"
	serviceTask     = "10000000-0000-4000-8000-000000000005"
	serviceRun      = "10000000-0000-4000-8000-000000000006"
	serviceRevision = "10000000-0000-4000-8000-000000000007"
)

var serviceNow = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func servicePrincipal() model.Principal {
	return model.Principal{UserID: serviceUser, CredentialID: serviceRun, Kind: model.PATCredential}
}
func serviceObservation(t *testing.T) monitoring.Observation {
	t.Helper()
	raw := fmt.Sprintf(`{"runId":%q,"sequence":"1","capturedAt":"2026-01-01T00:00:00Z","lifecycle":"running","scheduler":{"phase":"waiting-poll","coverage":"complete","cycleId":null,"lastCompletedAt":null,"lastSuccessfulAt":null,"lastOutcome":null,"nextPollAt":null},"capacity":null,"admission":{"observedAt":"2026-01-01T00:00:00Z","coverage":"complete","reasons":[]},"reservations":[],"activities":[],"currentFailures":[],"lastRecovery":null,"detailCoverage":"complete","delivery":{"lastSucceededAt":null,"lastFailure":null}}`, serviceRun)
	o, err := monitoring.ParseObservation([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return o
}

type monitorReader struct {
	store.WorkerReader
	workers func(context.Context, string, []string, time.Time) ([]string, error)
	sources func(context.Context, string, []string, []string) (store.WorkerMonitoringSources, error)
}

func (r monitorReader) MonitoringWorkers(ctx context.Context, u string, ids []string, now time.Time) ([]string, error) {
	if r.workers == nil {
		panic("unexpected MonitoringWorkers")
	}
	return r.workers(ctx, u, ids, now)
}
func (r monitorReader) MonitoringSources(ctx context.Context, u string, projects, tasks []string) (store.WorkerMonitoringSources, error) {
	if r.sources == nil {
		panic("unexpected MonitoringSources")
	}
	return r.sources(ctx, u, projects, tasks)
}

type monitorScope struct {
	store.SnapshotScope
	reader   monitorReader
	observed func(context.Context) (time.Time, error)
}

func (s monitorScope) WorkerDAO() store.WorkerReader                     { return s.reader }
func (s monitorScope) ObservedAt(ctx context.Context) (time.Time, error) { return s.observed(ctx) }

type monitorDB struct {
	store.WorkerWriter
	snapshot func(context.Context, func(store.SnapshotScope) error) error
}

func (d monitorDB) ReadSnapshot(ctx context.Context, f func(store.SnapshotScope) error) error {
	if d.snapshot == nil {
		panic("unexpected snapshot")
	}
	return d.snapshot(ctx, f)
}

type monitorStore struct {
	cas       func(context.Context, store.MonitoringIdentity, *string, store.MonitoringCandidate) (store.MonitoringCASResult, error)
	read      func(context.Context, store.MonitoringIdentity) (store.MonitoringReadResult, error)
	summaries func(context.Context, []store.MonitoringIdentity) (store.MonitoringSummariesResult, error)
}

func (m monitorStore) CompareAndSet(ctx context.Context, id store.MonitoringIdentity, r *string, c store.MonitoringCandidate) (store.MonitoringCASResult, error) {
	if m.cas == nil {
		panic("unexpected CAS")
	}
	return m.cas(ctx, id, r, c)
}
func (m monitorStore) Read(ctx context.Context, id store.MonitoringIdentity) (store.MonitoringReadResult, error) {
	if m.read == nil {
		panic("unexpected Read")
	}
	return m.read(ctx, id)
}
func (m monitorStore) ReadSummaries(ctx context.Context, ids []store.MonitoringIdentity) (store.MonitoringSummariesResult, error) {
	if m.summaries == nil {
		panic("unexpected summaries")
	}
	return m.summaries(ctx, ids)
}
func monitorFixture(t *testing.T, events *[]string) (*Workers, *monitorReader) {
	t.Helper()
	r := &monitorReader{}
	r.workers = func(ctx context.Context, u string, ids []string, now time.Time) ([]string, error) {
		*events = append(*events, "admit")
		if u != serviceUser || now != serviceNow {
			t.Fatalf("worker admission %s %v", u, now)
		}
		return append([]string(nil), ids...), nil
	}
	r.sources = func(ctx context.Context, u string, p, ids []string) (store.WorkerMonitoringSources, error) {
		*events = append(*events, "sources")
		if u != serviceUser || !reflect.DeepEqual(p, []string{serviceProject}) || !reflect.DeepEqual(ids, []string{serviceTask}) {
			t.Fatalf("sources arguments %s %v %v", u, p, ids)
		}
		return store.WorkerMonitoringSources{Projects: map[string]string{serviceProject: "project"}}, nil
	}
	db := monitorDB{snapshot: func(ctx context.Context, f func(store.SnapshotScope) error) error {
		*events = append(*events, "snapshot")
		return f(monitorScope{reader: *r, observed: func(ctx context.Context) (time.Time, error) { return serviceNow, nil }})
	}}
	return NewWorkers(db), r
}
func serviceFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func serviceRules(t *testing.T, events *[]string) monitoringRules {
	t.Helper()
	return monitoringRules{scopes: func(o monitoring.Observation) ([]string, []string) {
		*events = append(*events, "scopes")
		return []string{serviceProject}, []string{serviceTask}
	}, validateExecution: func(o monitoring.Observation, s store.WorkerMonitoringSources, u, w string) error {
		*events = append(*events, "validate")
		if u != serviceUser || w != serviceWorker || s.Projects[serviceProject] != "project" {
			t.Fatal("wrong validation arguments")
		}
		return nil
	}, project: func(d *monitoring.DetailResponse, s store.WorkerMonitoringSources) error {
		*events = append(*events, "project")
		if d.Data["runId"] != serviceRun || s.Projects[serviceProject] != "project" {
			t.Fatal("wrong projection arguments")
		}
		d.PermissionProjection = "restricted"
		return nil
	}, summaryScopes: func(summaries []monitoring.StoredSummary) ([]string, []string) {
		*events = append(*events, "summary scopes")
		return []string{serviceProject}, []string{serviceTask}
	}, projectSummary: func(_ monitoring.StoredSummary, sources store.WorkerMonitoringSources) (json.RawMessage, error) {
		*events = append(*events, "project summary")
		if sources.Projects[serviceProject] != "project" {
			t.Fatal("wrong summary sources")
		}
		return json.RawMessage(`{"public":true}`), nil
	}}
}
func TestMonitoringServiceWriteCAS(t *testing.T) {
	for _, tc := range []struct {
		name    string
		kind    store.MonitoringCASKind
		err     error
		code    string
		receipt bool
	}{
		{"accepted", store.MonitoringAccepted, nil, "", true}, {"duplicate", store.MonitoringDuplicate, nil, "", true},
		{"revision", store.MonitoringRevisionConflict, nil, "monitoring_revision_conflict", false}, {"stale", store.MonitoringSequenceStale, nil, "monitoring_sequence_stale", false}, {"sample", store.MonitoringSampleConflict, nil, "monitoring_sample_conflict", false}, {"lost", store.MonitoringStateLost, nil, "monitoring_state_lost", false},
		{"missing receipt", store.MonitoringAccepted, nil, "monitoring_unavailable", false}, {"unknown kind", "bad", nil, "monitoring_unavailable", false},
		{"unavailable", "", errors.New("offline"), "monitoring_unavailable", false}, {"unknown outcome", "", store.ErrMonitoringWriteOutcomeUnknown, "monitoring_write_outcome_unknown", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			events := []string{}
			s, _ := monitorFixture(t, &events)
			expected := serviceRevision
			receipt := store.MonitoringReceipt{Revision: serviceRevision, RunID: serviceRun, Sequence: "1", ReceivedAt: serviceNow, ExpiresAt: serviceNow.Add(time.Hour)}
			s.SetMonitoringStore(monitorStore{cas: func(ctx context.Context, id store.MonitoringIdentity, rev *string, c store.MonitoringCandidate) (store.MonitoringCASResult, error) {
				events = append(events, "cas")
				if id != (store.MonitoringIdentity{UserID: serviceUser, WorkerID: serviceWorker}) || rev == nil || *rev != expected || c.RunID != serviceRun || c.Sequence != "1" {
					t.Fatalf("write arguments %#v %#v %#v", id, rev, c)
				}
				if _, err := monitoring.ParseObservation(c.Body); err != nil {
					t.Fatal(err)
				}
				if _, err := monitoring.ParseStoredSummary(c.Summary); err != nil {
					t.Fatal(err)
				}
				var r *store.MonitoringReceipt
				if tc.receipt {
					r = &receipt
				}
				return store.MonitoringCASResult{Kind: tc.kind, Receipt: r}, tc.err
			}})
			got, err := s.putMonitoring(context.Background(), servicePrincipal(), serviceWorker, &expected, serviceObservation(t), serviceRules(t, &events))
			if tc.code == "" {
				if err != nil || got != receipt {
					t.Fatalf("receipt %+v %v", got, err)
				}
			} else {
				serviceFault(t, err, tc.code)
				if tc.err != nil && !errors.Is(err, tc.err) {
					t.Fatalf("lost cause %v", err)
				}
			}
			if !reflect.DeepEqual(events, []string{"scopes", "snapshot", "admit", "sources", "validate", "cas"}) {
				t.Fatalf("order %v", events)
			}
		})
	}
}
func TestMonitoringServiceAdmissionAndFailure(t *testing.T) {
	t.Run("batch denial before Redis", func(t *testing.T) {
		events := []string{}
		s, r := monitorFixture(t, &events)
		r.workers = func(context.Context, string, []string, time.Time) ([]string, error) {
			events = append(events, "admit")
			return []string{serviceWorker}, nil
		}
		s.SetMonitoringStore(monitorStore{})
		_, err := s.QueryMonitoring(context.Background(), servicePrincipal(), []string{serviceWorker, serviceWorker2})
		serviceFault(t, err, "not_found")
		if !reflect.DeepEqual(events, []string{"snapshot", "admit"}) {
			t.Fatal(events)
		}
	})
	t.Run("worker ids and identity", func(t *testing.T) {
		s, _ := monitorFixture(t, &[]string{})
		for _, ids := range [][]string{nil, {serviceWorker, serviceWorker}, {strings.ToUpper("a0000000-0000-4000-8000-000000000002")}, {"bad"}, make([]string, 101)} {
			_, err := s.QueryMonitoring(context.Background(), servicePrincipal(), ids)
			serviceFault(t, err, "invalid_input")
		}
		_, err := s.QueryMonitoring(context.Background(), model.Principal{}, []string{serviceWorker})
		serviceFault(t, err, "unauthenticated")
		bad := "NO"
		_, err = s.PutMonitoring(context.Background(), servicePrincipal(), serviceWorker, &bad, serviceObservation(t))
		serviceFault(t, err, "invalid_input")
	})
	t.Run("missing dependency", func(t *testing.T) {
		events := []string{}
		s, _ := monitorFixture(t, &events)
		_, err := s.QueryMonitoring(context.Background(), servicePrincipal(), []string{serviceWorker})
		serviceFault(t, err, "monitoring_unavailable")
	})
	t.Run("snapshot error preserved", func(t *testing.T) {
		sentinel := errors.New("snapshot interrupted")
		s := NewWorkers(monitorDB{snapshot: func(context.Context, func(store.SnapshotScope) error) error { return sentinel }})
		_, err := s.GetMonitoring(context.Background(), servicePrincipal(), serviceWorker)
		if !errors.Is(err, sentinel) {
			t.Fatalf("lost cause %v", err)
		}
	})
	t.Run("validation failure blocks write", func(t *testing.T) {
		events := []string{}
		s, _ := monitorFixture(t, &events)
		s.SetMonitoringStore(monitorStore{})
		rules := serviceRules(t, &events)
		sentinel := errors.New("validation failure")
		rules.validateExecution = func(monitoring.Observation, store.WorkerMonitoringSources, string, string) error { return sentinel }
		_, err := s.putMonitoring(context.Background(), servicePrincipal(), serviceWorker, nil, serviceObservation(t), rules)
		if !errors.Is(err, sentinel) {
			t.Fatalf("lost cause %v", err)
		}
	})
}
func TestMonitoringServiceReads(t *testing.T) {
	t.Run("absent", func(t *testing.T) {
		events := []string{}
		s, _ := monitorFixture(t, &events)
		s.SetMonitoringStore(monitorStore{read: func(ctx context.Context, id store.MonitoringIdentity) (store.MonitoringReadResult, error) {
			events = append(events, "read")
			return store.MonitoringReadResult{ObservedAt: serviceNow}, nil
		}})
		out, err := s.GetMonitoring(context.Background(), servicePrincipal(), serviceWorker)
		if err != nil || out.State != "absent" || out.Data != nil || out.DetailCoverage != "complete" || out.PermissionProjection != "current" || out.ObservedAt != serviceNow {
			t.Fatalf("absent %+v %v", out, err)
		}
		if !reflect.DeepEqual(events, []string{"snapshot", "admit", "read"}) {
			t.Fatal(events)
		}
	})
	t.Run("current authorization after read", func(t *testing.T) {
		events := []string{}
		s, _ := monitorFixture(t, &events)
		body, _ := json.Marshal(serviceObservation(t))
		receipt := store.MonitoringReceipt{Revision: serviceRevision, RunID: serviceRun, Sequence: "1", ReceivedAt: serviceNow, ExpiresAt: serviceNow.Add(time.Hour)}
		s.SetMonitoringStore(monitorStore{read: func(ctx context.Context, id store.MonitoringIdentity) (store.MonitoringReadResult, error) {
			events = append(events, "read")
			if id.WorkerID != serviceWorker || id.UserID != serviceUser {
				t.Fatal(id)
			}
			return store.MonitoringReadResult{ObservedAt: serviceNow, Value: &store.MonitoringValue{Receipt: receipt, Body: body}}, nil
		}})
		out, err := s.getMonitoring(context.Background(), servicePrincipal(), serviceWorker, serviceRules(t, &events))
		if err != nil || out.State != "available" || out.PermissionProjection != "restricted" || out.Revision == nil || *out.Revision != serviceRevision {
			t.Fatalf("available %+v %v", out, err)
		}
		if !reflect.DeepEqual(events, []string{"snapshot", "admit", "read", "scopes", "snapshot", "admit", "sources", "project"}) {
			t.Fatal(events)
		}
	})
	t.Run("stored malformed or offline", func(t *testing.T) {
		for _, tc := range []struct {
			body json.RawMessage
			err  error
		}{{json.RawMessage(`{"bad":true}`), nil}, {nil, errors.New("redis offline")}} {
			events := []string{}
			s, _ := monitorFixture(t, &events)
			s.SetMonitoringStore(monitorStore{read: func(context.Context, store.MonitoringIdentity) (store.MonitoringReadResult, error) {
				return store.MonitoringReadResult{Value: &store.MonitoringValue{Body: tc.body}}, tc.err
			}})
			_, err := s.GetMonitoring(context.Background(), servicePrincipal(), serviceWorker)
			serviceFault(t, err, "monitoring_unavailable")
			if tc.err == nil {
				var failure *store.MonitoringError
				var cause *model.Fault
				if !errors.As(err, &failure) || failure.Kind != "format" || !errors.As(failure.Cause, &cause) || cause.Code != "invalid_input" {
					t.Fatalf("stored body classification: %v", err)
				}
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatal(err)
			}
		}
	})
	t.Run("summary ordering and corruption", func(t *testing.T) {
		events := []string{}
		s, _ := monitorFixture(t, &events)
		summary, err := monitoring.Summary(serviceObservation(t))
		if err != nil {
			t.Fatal(err)
		}
		s.SetMonitoringStore(monitorStore{summaries: func(ctx context.Context, ids []store.MonitoringIdentity) (store.MonitoringSummariesResult, error) {
			events = append(events, "summaries")
			if !reflect.DeepEqual(ids, []store.MonitoringIdentity{{UserID: serviceUser, WorkerID: serviceWorker2}, {UserID: serviceUser, WorkerID: serviceWorker}}) {
				t.Fatal(ids)
			}
			return store.MonitoringSummariesResult{ObservedAt: serviceNow, Values: []*store.MonitoringValue{nil, {Receipt: store.MonitoringReceipt{Revision: serviceRevision, ReceivedAt: serviceNow, ExpiresAt: serviceNow.Add(time.Hour)}, Summary: summary}}}, nil
		}})
		rules := serviceRules(t, &events)
		rules.summaryScopes = func(summaries []monitoring.StoredSummary) ([]string, []string) {
			events = append(events, "summary scopes")
			if len(summaries) != 2 || summaries[0].Admission.ObservedAt != "" || summaries[1].Admission.ObservedAt != "2026-01-01T00:00:00Z" {
				t.Fatalf("summary inputs %+v", summaries)
			}
			return []string{serviceProject}, []string{serviceTask}
		}
		out, err := s.queryMonitoring(context.Background(), servicePrincipal(), []string{serviceWorker2, serviceWorker}, rules)
		if err != nil || len(out.Items) != 2 || out.Items[0].State != "absent" || out.Items[0].WorkerID != serviceWorker2 || out.Items[1].State != "available" || out.Items[1].WorkerID != serviceWorker {
			t.Fatalf("query %+v %v", out, err)
		}
		if string(out.Items[1].Summary) != `{"public":true}` {
			t.Fatalf("summary was not projected: %s", out.Items[1].Summary)
		}
		if !reflect.DeepEqual(events, []string{"snapshot", "admit", "summaries", "summary scopes", "snapshot", "admit", "sources", "project summary"}) {
			t.Fatal(events)
		}
		s.SetMonitoringStore(monitorStore{summaries: func(context.Context, []store.MonitoringIdentity) (store.MonitoringSummariesResult, error) {
			return store.MonitoringSummariesResult{Values: []*store.MonitoringValue{{Summary: json.RawMessage(`{"secret":"value"}`)}}}, nil
		}})
		_, err = s.QueryMonitoring(context.Background(), servicePrincipal(), []string{serviceWorker})
		serviceFault(t, err, "monitoring_unavailable")
		var failure *store.MonitoringError
		var cause *model.Fault
		if !errors.As(err, &failure) || failure.Kind != "format" || !errors.As(failure.Cause, &cause) || cause.Code != "invalid_input" {
			t.Fatalf("stored summary classification: %v", err)
		}
	})
}

func TestMonitoringServiceWorktreePersistenceAndCurrentPermission(t *testing.T) {
	events := []string{}
	s, reader := monitorFixture(t, &events)
	visible := true
	reader.sources = func(_ context.Context, _ string, projects, tasks []string) (store.WorkerMonitoringSources, error) {
		if !reflect.DeepEqual(projects, []string{serviceProject}) || !reflect.DeepEqual(tasks, []string{serviceTask}) {
			t.Fatalf("incorrect permission inputs: %v %v", projects, tasks)
		}
		if !visible {
			return store.WorkerMonitoringSources{}, nil
		}
		return store.WorkerMonitoringSources{Projects: map[string]string{serviceProject: "Project"}, Tasks: map[string]store.WorkerTaskSource{serviceTask: {Task: model.Task{ID: serviceTask, ProjectID: serviceProject, Title: "Task"}, ProjectName: "Project"}}}, nil
	}
	o := serviceObservation(t)
	o["currentFailures"] = []any{map[string]any{
		"operationId": serviceRun, "component": "cleanup", "phase": "archive", "scope": map[string]any{"kind": "claim", "projectId": serviceProject, "taskId": serviceTask, "claimId": serviceRun},
		"error":           map[string]any{"type": "operation", "code": "unknown", "cause": "The operation failed; inspect local Worker diagnostics for details.", "causeTruncated": false},
		"firstObservedAt": "2026-01-01T00:00:00Z", "lastObservedAt": "2026-01-01T00:00:00Z", "occurrencesInRun": 1, "retryState": "none", "nextAttemptAt": nil,
		"worktree": map[string]any{"kind": "project-relative", "path": "../tree/<>&"},
	}}
	receipt := store.MonitoringReceipt{Revision: serviceRevision, RunID: serviceRun, Sequence: "1", ReceivedAt: serviceNow, ExpiresAt: serviceNow.Add(time.Hour)}
	var saved store.MonitoringCandidate
	s.SetMonitoringStore(monitorStore{
		cas: func(_ context.Context, _ store.MonitoringIdentity, _ *string, c store.MonitoringCandidate) (store.MonitoringCASResult, error) {
			saved = c
			return store.MonitoringCASResult{Kind: store.MonitoringAccepted, Receipt: &receipt}, nil
		},
		read: func(context.Context, store.MonitoringIdentity) (store.MonitoringReadResult, error) {
			return store.MonitoringReadResult{ObservedAt: serviceNow, Value: &store.MonitoringValue{Receipt: receipt, Body: saved.Body, Summary: saved.Summary}}, nil
		},
	})
	if _, err := s.PutMonitoring(context.Background(), servicePrincipal(), serviceWorker, nil, o); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(saved.Summary), "worktree") || !strings.Contains(string(saved.Body), `"worktree"`) {
		t.Fatalf("incorrect storage: body=%s summary=%s", saved.Body, saved.Summary)
	}
	out, err := s.GetMonitoring(context.Background(), servicePrincipal(), serviceWorker)
	if err != nil || out.Data["currentFailures"].([]any)[0].(map[string]any)["worktree"].(map[string]any)["path"] != "../tree/<>&" {
		t.Fatalf("visible detail: %+v %v", out, err)
	}
	visible = false
	out, err = s.GetMonitoring(context.Background(), servicePrincipal(), serviceWorker)
	if err != nil || out.PermissionProjection != "restricted" || len(out.Data["currentFailures"].([]any)) != 0 {
		t.Fatalf("revoked detail: %+v %v", out, err)
	}
}

func TestMonitoringServiceContextAndSnapshotCompletion(t *testing.T) {
	t.Run("cancellation reaches Redis and preserves cause", func(t *testing.T) {
		events := []string{}
		s, _ := monitorFixture(t, &events)
		started := make(chan struct{})
		finished := make(chan error, 1)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		s.SetMonitoringStore(monitorStore{read: func(ctx context.Context, id store.MonitoringIdentity) (store.MonitoringReadResult, error) {
			close(started)
			<-ctx.Done()
			return store.MonitoringReadResult{}, ctx.Err()
		}})
		go func() { _, err := s.GetMonitoring(ctx, servicePrincipal(), serviceWorker); finished <- err }()
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("Redis read not called")
		}
		cancel()
		select {
		case err := <-finished:
			serviceFault(t, err, "monitoring_unavailable")
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("lost cancellation: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("Redis read did not return after cancellation")
		}
	})
	t.Run("snapshot completion failure takes precedence over refusal", func(t *testing.T) {
		marker := errors.New("snapshot completion failure")
		reader := monitorReader{workers: func(context.Context, string, []string, time.Time) ([]string, error) { return nil, nil }}
		db := monitorDB{snapshot: func(ctx context.Context, f func(store.SnapshotScope) error) error {
			if err := f(monitorScope{reader: reader, observed: func(context.Context) (time.Time, error) { return serviceNow, nil }}); err != nil {
				t.Fatalf("unexpected callback error %v", err)
			}
			return marker
		}}
		s := NewWorkers(db)
		s.SetMonitoringStore(monitorStore{})
		_, err := s.QueryMonitoring(context.Background(), servicePrincipal(), []string{serviceWorker})
		if !errors.Is(err, marker) {
			t.Fatalf("completion was hidden: %v", err)
		}
	})
	t.Run("permission read failure takes precedence over projection", func(t *testing.T) {
		events := []string{}
		s, r := monitorFixture(t, &events)
		body, err := json.Marshal(serviceObservation(t))
		if err != nil {
			t.Fatal(err)
		}
		sentinel := errors.New("permission read failed")
		r.sources = func(context.Context, string, []string, []string) (store.WorkerMonitoringSources, error) {
			return store.WorkerMonitoringSources{}, sentinel
		}
		s.SetMonitoringStore(monitorStore{read: func(context.Context, store.MonitoringIdentity) (store.MonitoringReadResult, error) {
			return store.MonitoringReadResult{Value: &store.MonitoringValue{Body: body}}, nil
		}})
		_, err = s.getMonitoring(context.Background(), servicePrincipal(), serviceWorker, serviceRules(t, &events))
		if !errors.Is(err, sentinel) {
			t.Fatalf("permission failure suppressed: %v", err)
		}
	})
}

func TestMonitoringSummaryRechecksResourcesAndPropagatesProjectionFailures(t *testing.T) {
	for _, tc := range []struct {
		name                                              string
		deny, sourceFailure, projectionFailure, oversized bool
	}{
		{name: "worker withdrawn", deny: true},
		{name: "permission read failed", sourceFailure: true},
		{name: "projection failed", projectionFailure: true},
		{name: "actual encoded response exceeds budget", oversized: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			events := []string{}
			s, r := monitorFixture(t, &events)
			observed := serviceObservation(t)
			summary, err := monitoring.Summary(observed)
			if err != nil {
				t.Fatal(err)
			}
			s.SetMonitoringStore(monitorStore{summaries: func(ctx context.Context, ids []store.MonitoringIdentity) (store.MonitoringSummariesResult, error) {
				events = append(events, "summaries")
				if !reflect.DeepEqual(ids, []store.MonitoringIdentity{{UserID: serviceUser, WorkerID: serviceWorker}}) {
					t.Fatalf("identities %v", ids)
				}
				return store.MonitoringSummariesResult{ObservedAt: serviceNow, Values: []*store.MonitoringValue{{Receipt: store.MonitoringReceipt{Revision: serviceRevision, ReceivedAt: serviceNow, ExpiresAt: serviceNow.Add(time.Hour)}, Summary: summary}}}, nil
			}})
			calls := 0
			r.workers = func(_ context.Context, user string, ids []string, now time.Time) ([]string, error) {
				events = append(events, "admit")
				calls++
				if user != serviceUser || now != serviceNow || !reflect.DeepEqual(ids, []string{serviceWorker}) {
					t.Fatalf("admission %s %v %v", user, ids, now)
				}
				if tc.deny && calls == 2 {
					return nil, nil
				}
				return ids, nil
			}
			failure := errors.New("controlled failure")
			if tc.sourceFailure {
				r.sources = func(context.Context, string, []string, []string) (store.WorkerMonitoringSources, error) {
					events = append(events, "sources")
					return store.WorkerMonitoringSources{}, failure
				}
			}
			rules := serviceRules(t, &events)
			if tc.projectionFailure {
				rules.projectSummary = func(monitoring.StoredSummary, store.WorkerMonitoringSources) (json.RawMessage, error) {
					events = append(events, "project summary")
					return nil, failure
				}
			}
			if tc.oversized {
				rules.projectSummary = func(monitoring.StoredSummary, store.WorkerMonitoringSources) (json.RawMessage, error) {
					events = append(events, "project summary")
					return json.RawMessage(`"` + strings.Repeat("<", monitoring.MaxQuery) + `"`), nil
				}
			}
			out, err := s.queryMonitoring(context.Background(), servicePrincipal(), []string{serviceWorker}, rules)
			if tc.deny {
				serviceFault(t, err, "not_found")
			} else if tc.sourceFailure {
				if !errors.Is(err, failure) {
					t.Fatalf("lost source error: %v", err)
				}
			} else {
				serviceFault(t, err, "monitoring_unavailable")
				if tc.projectionFailure && !errors.Is(err, failure) {
					t.Fatalf("lost projection error: %v", err)
				}
			}
			if len(out.Items) != 0 {
				t.Fatalf("published partial result: %+v", out)
			}
			if calls != 2 {
				t.Fatalf("expected re-admission, got %v", events)
			}
			if tc.deny && !reflect.DeepEqual(events, []string{"snapshot", "admit", "summaries", "summary scopes", "snapshot", "admit"}) {
				t.Fatalf("denial order %v", events)
			}
		})
	}
}
