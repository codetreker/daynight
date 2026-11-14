package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const personalProject2 = "20000000-0000-4000-8000-000000000001"
const personalTask2 = "20000000-0000-4000-8000-000000000002"

type personalReader struct {
	store.TaskReader
	t                    *testing.T
	facts                []store.PersonalTaskProject
	page                 store.PersonalTaskPage
	factCalls, pageCalls int
	factsErr, pageErr    error
}

func (r *personalReader) PersonalTaskFacts(_ context.Context, actor string) ([]store.PersonalTaskProject, error) {
	if actor != workActor {
		r.t.Fatal("wrong facts actor")
	}
	r.factCalls++
	return r.facts, r.factsErr
}
func (r *personalReader) PersonalTaskPage(_ context.Context, actor string, query store.PersonalTaskQuery) (store.PersonalTaskPage, error) {
	if actor != workActor || query.Limit != 50 || query.After != nil {
		r.t.Fatalf("wrong page query: %s %#v", actor, query)
	}
	r.pageCalls++
	return r.page, r.pageErr
}

type personalSources struct {
	store.SessionReader
	t        *testing.T
	database *workServiceStore
	calls    []string
	failOn   int
	failure  error
	modify   func(int, *store.TaskSessionSource) bool
}

func (s *personalSources) TaskSessionSources(_ context.Context, project string, ids []string) ([]store.TaskSessionSource, error) {
	if !s.database.active || len(ids) != 1 {
		s.t.Fatalf("incorrect source scope: %s %v", project, ids)
	}
	s.calls = append(s.calls, project)
	if s.failOn == len(s.calls) {
		return nil, s.failure
	}
	source := store.TaskSessionSource{ProjectID: project, TaskID: ids[0], TaskVersion: 1, TaskStatus: model.TaskInProgress}
	if s.modify != nil && !s.modify(len(s.calls), &source) {
		return nil, nil
	}
	return []store.TaskSessionSource{source}, nil
}

type personalObserver struct {
	t        *testing.T
	database *workServiceStore
	projects []string
	after    func()
	failure  error
}

func (o *personalObserver) ObserveTaskSessions(_ context.Context, _ model.Principal, sources []store.TaskSessionSource) (map[string]sp.TaskSessionObservation, error) {
	if o.database.active || len(sources) != 1 {
		o.t.Fatalf("sampled while snapshot held or wrong sources: %#v", sources)
	}
	o.projects = append(o.projects, sources[0].ProjectID)
	if o.after != nil {
		o.after()
	}
	if o.failure != nil {
		return nil, o.failure
	}
	return map[string]sp.TaskSessionObservation{sources[0].TaskID: {Observation: "observed"}}, nil
}
func personalFixture(t *testing.T) (*Observations, *personalReader, *personalSources, *personalObserver, *workServiceStore, *int) {
	t.Helper()
	reader := &personalReader{t: t, facts: []store.PersonalTaskProject{
		{ID: workProject, Name: "A", MatchedCount: "3"},
		{ID: personalProject2, Name: "B", MatchedCount: "4"},
	}, page: store.PersonalTaskPage{Items: []store.PersonalTaskRow{
		{ProjectID: workProject, ID: workGroup, Version: 1},
		{ProjectID: personalProject2, ID: personalTask2, Version: 1},
	}}}
	database := &workServiceStore{}
	sources := &personalSources{t: t, database: database}
	observer := &personalObserver{t: t, database: database}
	database.snapshot = workServiceSnapshot{tasks: reader, sessions: sources}
	s := NewObservations(database, observer)
	credentials := new(int)
	s.operations.credential = func(_ context.Context, _ store.CredentialReader, p model.Principal) error {
		if !database.active || p.UserID != workActor {
			t.Fatal("credential outside snapshot or wrong identity")
		}
		*credentials++
		return nil
	}
	s.operations.access = func(_ context.Context, _ projectcore.ProjectAccessReader, p model.Principal, project string) (model.ProjectAccess, error) {
		if !database.active || p.UserID != workActor || project != workProject && project != personalProject2 {
			t.Fatal("wrong project recheck")
		}
		return model.ProjectAccess{}, nil
	}
	return s, reader, sources, observer, database, credentials
}
func personalPrincipal() model.Principal {
	return model.Principal{UserID: workActor, CredentialID: workProject, Kind: model.PATCredential}
}

func TestPersonalTasksProjectSourcesAndSnapshots(t *testing.T) {
	s, reader, sources, observer, _, credentials := personalFixture(t)
	result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
	if err != nil || len(result.Items) != 2 || result.TotalTaskCount != 7 || result.TotalProjectCount != 2 || result.Items[0].MatchedTaskCount != 3 || result.Items[1].MatchedTaskCount != 4 || result.SessionPartial || result.Items[1].Session.Observation != "observed" {
		t.Fatalf("result: %#v %v", result, err)
	}
	if reader.factCalls != 2 || reader.pageCalls != 1 || *credentials != 4 || len(sources.calls) != 4 || len(observer.projects) != 2 || observer.projects[0] != workProject || observer.projects[1] != personalProject2 {
		t.Fatalf("calls facts=%d page=%d credentials=%d sources=%v observations=%v", reader.factCalls, reader.pageCalls, *credentials, sources.calls, observer.projects)
	}
}

func TestPersonalTasksWorkerSelectionAndFailure(t *testing.T) {
	worker := &model.WorkerClaim{ClaimID: "claim", State: model.WorkerActive, WorkerID: "worker", Machine: model.WorkerMachine{ID: "machine", Name: "Long 名称"}}
	t.Run("different and shared workers", func(t *testing.T) {
		for _, shared := range []bool{false, true} {
			s, _, sources, _, _, _ := personalFixture(t)
			second := *worker
			if !shared {
				second.WorkerID, second.Machine.ID, second.Machine.Name = "other", "other-machine", "Other"
			}
			sources.modify = func(_ int, source *store.TaskSessionSource) bool {
				if source.ProjectID == workProject {
					source.Worker = worker
				} else {
					source.Worker = &second
				}
				return true
			}
			result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
			if err != nil || len(result.Items) != 2 || result.Items[0].Worker == nil || result.Items[1].Worker == nil || result.Items[0].Worker.WorkerID != worker.WorkerID || result.Items[1].Worker.WorkerID != second.WorkerID || result.Items[1].Worker.Machine != second.Machine {
				t.Fatalf("shared=%v workers=%#v error=%v", shared, result.Items, err)
			}
		}
	})
	t.Run("session change is partial, worker retained", func(t *testing.T) {
		s, _, sources, _, _, _ := personalFixture(t)
		sources.modify = func(call int, source *store.TaskSessionSource) bool {
			source.Worker = worker
			if call == 3 {
				source.Session = &store.TaskSessionStateSource{SessionID: "new"}
			}
			return true
		}
		result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
		if err != nil || !result.SessionPartial || result.Items[0].Worker == nil || result.Items[0].Worker.WorkerID != worker.WorkerID {
			t.Fatalf("session change: %#v %v", result, err)
		}
	})
	t.Run("active despite observation failure", func(t *testing.T) {
		s, _, sources, observer, _, _ := personalFixture(t)
		sources.modify = func(_ int, source *store.TaskSessionSource) bool { source.Worker = worker; return true }
		observer.failure = errors.New("offline")
		result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
		if err != nil || !result.SessionPartial || result.Items[0].Worker == nil || result.Items[0].Worker.WorkerID != worker.WorkerID || result.Items[0].Worker.Machine != worker.Machine {
			t.Fatalf("worker lost: %#v %v", result, err)
		}
	})
	for _, test := range []struct {
		name   string
		change func(*store.TaskSessionSource) bool
	}{
		{"missing", func(*store.TaskSessionSource) bool { return false }},
		{"task", func(s *store.TaskSessionSource) bool { s.TaskID = personalTask2; return true }},
		{"project", func(s *store.TaskSessionSource) bool { s.ProjectID = personalProject2; return true }},
		{"version", func(s *store.TaskSessionSource) bool { s.TaskVersion++; return true }},
		{"status", func(s *store.TaskSessionSource) bool { s.TaskStatus = model.TaskDone; return true }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, sources, observer, _, _ := personalFixture(t)
			sources.modify = func(_ int, source *store.TaskSessionSource) bool { return test.change(source) }
			result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
			if err == nil || result.Items != nil || len(observer.projects) != 0 {
				t.Fatalf("invalid source published: %#v %v", result, err)
			}
		})
	}
	for _, test := range []struct {
		name   string
		change func(*store.TaskSessionSource)
	}{
		{"released", func(s *store.TaskSessionSource) { s.Worker = nil }},
		{"completed", func(s *store.TaskSessionSource) {
			copy := *s.Worker
			copy.State = model.WorkerCompleted
			s.Worker = &copy
		}},
		{"version", func(s *store.TaskSessionSource) { s.TaskVersion++ }},
	} {
		t.Run("sampling "+test.name, func(t *testing.T) {
			s, _, sources, _, _, _ := personalFixture(t)
			sources.modify = func(call int, source *store.TaskSessionSource) bool {
				source.Worker = worker
				if call == 3 {
					test.change(source)
				}
				return true
			}
			result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "reset_required" || result.Items != nil {
				t.Fatalf("changed binding published: %#v %v", result, err)
			}
		})
	}
}
func TestPersonalTasksEmptyStillChecksCredentialAndRevision(t *testing.T) {
	s, r, _, observer, _, credentials := personalFixture(t)
	r.facts, r.page.Items = nil, nil
	result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
	if err != nil || len(result.Items) != 0 || result.TotalTaskCount != 0 || *credentials != 2 || r.factCalls != 2 || len(observer.projects) != 0 {
		t.Fatalf("empty: %#v %v", result, err)
	}
}
func TestPersonalTasksRejectsChangesAndPreservesOrdinaryObservationFailure(t *testing.T) {
	t.Run("revision", func(t *testing.T) {
		s, r, _, o, _, _ := personalFixture(t)
		o.after = func() { r.facts[0].Name = "changed" }
		result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "reset_required" || result.Items != nil {
			t.Fatalf("changed: %#v %v", result, err)
		}
	})
	t.Run("failure", func(t *testing.T) {
		s, _, _, o, _, _ := personalFixture(t)
		o.failure = errors.New("private detail")
		result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
		if err != nil || !result.SessionPartial || len(result.Items) != 2 || result.Items[0].Session.Observation != "unavailable" {
			t.Fatalf("partial: %#v %v", result, err)
		}
	})
	t.Run("lost access", func(t *testing.T) {
		s, r, _, o, _, _ := personalFixture(t)
		o.after = func() { r.facts = r.facts[1:] }
		s.operations.access = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
			return model.ProjectAccess{}, &model.Fault{Code: "forbidden"}
		}
		result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "reset_required" || result.Items != nil || len(o.projects) != 1 {
			t.Fatalf("lost access: %#v %v", result, err)
		}
	})
	t.Run("credential revoked", func(t *testing.T) {
		s, _, _, o, _, _ := personalFixture(t)
		revoked := false
		o.after = func() { revoked = true }
		s.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error {
			if revoked {
				return &model.Fault{Code: "unauthenticated"}
			}
			return nil
		}
		result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "unauthenticated" || result.Items != nil {
			t.Fatalf("revoked: %#v %v", result, err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		s, r, _, o, _, _ := personalFixture(t)
		ctx, cancel := context.WithCancel(t.Context())
		o.after = cancel
		result, err := s.PersonalTasks(ctx, personalPrincipal(), 0, nil)
		if !errors.Is(err, context.Canceled) || result.Items != nil || len(o.projects) != 1 || r.factCalls != 1 {
			t.Fatalf("cancel: %#v %v", result, err)
		}
	})
}

func TestPersonalTasksSelectionFailuresNeverPublish(t *testing.T) {
	cause := errors.New("storage failed")
	for _, test := range []struct {
		name    string
		prepare func(*personalReader, *workServiceStore)
		want    error
	}{
		{"facts", func(r *personalReader, _ *workServiceStore) { r.factsErr = cause }, cause},
		{"page", func(r *personalReader, _ *workServiceStore) { r.pageErr = cause }, cause},
		{"snapshot completion", func(_ *personalReader, s *workServiceStore) { s.completion = cause }, cause},
		{"count exceeds precision", func(r *personalReader, _ *workServiceStore) { r.facts[0].MatchedCount = "9007199254740992" }, nil},
		{"invalid paused", func(r *personalReader, _ *workServiceStore) { value := `"true"`; r.page.Items[0].PausedRaw = &value }, nil},
		{"unknown project", func(r *personalReader, _ *workServiceStore) { r.page.Items[0].ProjectID = personalTask2 }, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, r, _, observer, database, _ := personalFixture(t)
			test.prepare(r, database)
			result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
			if err == nil || test.want != nil && !errors.Is(err, test.want) || result.Items != nil || len(observer.projects) != 0 {
				t.Fatalf("selection failure published: %#v %v observations=%v", result, err, observer.projects)
			}
		})
	}
}

func TestPersonalTasksSourceStorageFailuresAreNotObservationFailures(t *testing.T) {
	cause := errors.New("source storage failed")
	for _, failOn := range []int{1, 3} {
		t.Run(map[int]string{1: "selection", 3: "recheck"}[failOn], func(t *testing.T) {
			s, r, sources, observer, _, _ := personalFixture(t)
			sources.failOn, sources.failure = failOn, cause
			result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
			if !errors.Is(err, cause) || result.Items != nil || len(sources.calls) != failOn || r.factCalls != 1 || len(observer.projects) != (failOn-1)/2 {
				t.Fatalf("source failure: %#v %v sources=%v observations=%v facts=%d", result, err, sources.calls, observer.projects, r.factCalls)
			}
		})
	}
	t.Run("recheck snapshot completion", func(t *testing.T) {
		s, r, _, observer, database, _ := personalFixture(t)
		observer.after = func() { database.completion = cause }
		result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
		if !errors.Is(err, cause) || result.Items != nil || len(observer.projects) != 1 || r.factCalls != 1 {
			t.Fatalf("completion failure: %#v %v observations=%v facts=%d", result, err, observer.projects, r.factCalls)
		}
	})
}

func TestPersonalTasksDoesNotMaskCompositeAuthorityAndStorageFailure(t *testing.T) {
	refusal := &model.Fault{Code: "forbidden"}
	cleanup := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: refusal}
	database := &store.Error{Phase: "query", DatabaseFailure: true, Cause: refusal}
	for _, test := range []struct {
		name    string
		failure error
	}{
		{"cleanup", cleanup}, {"database", database}, {"joined", errors.Join(refusal, cleanup)},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, r, sources, observer, _, _ := personalFixture(t)
			sources.failOn, sources.failure = 3, test.failure
			observer.after = func() { r.facts = r.facts[1:] }
			result, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
			if !errors.Is(err, test.failure) || result.Items != nil || r.factCalls != 1 || len(observer.projects) != 1 {
				t.Fatalf("composite failure masked: %#v %v facts=%d", result, err, r.factCalls)
			}
		})
	}
}

func TestPersonalTasksErrorsExposePhaseAndOriginalCause(t *testing.T) {
	cause := &model.Fault{Code: "forbidden", Message: "private detail"}
	for _, test := range []struct {
		phase string
		setup func(*personalReader, *personalSources, *personalObserver)
	}{
		{"select", func(r *personalReader, _ *personalSources, _ *personalObserver) { r.factsErr = cause }},
		{"observe", func(_ *personalReader, _ *personalSources, o *personalObserver) { o.failure = cause }},
		{"recheck", func(_ *personalReader, sources *personalSources, _ *personalObserver) {
			sources.failOn, sources.failure = 3, cause
		}},
	} {
		t.Run(test.phase, func(t *testing.T) {
			s, r, sources, observer, _, _ := personalFixture(t)
			test.setup(r, sources, observer)
			_, err := s.PersonalTasks(t.Context(), personalPrincipal(), 0, nil)
			var stage *PersonalTaskError
			if !errors.As(err, &stage) || stage.Phase != test.phase || !errors.Is(err, cause) || stage.Error() == cause.Message {
				t.Fatalf("phase or cause lost: %#v %v", stage, err)
			}
		})
	}
}
