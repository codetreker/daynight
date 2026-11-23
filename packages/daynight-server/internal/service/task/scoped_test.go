package task_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func readAuthorization(t *testing.T, f *taskReadFixture, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	f.principal.Kind = model.PATCredential
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: f.principal, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedGraphTaskOnlyNeverReadsProjectProjection(t *testing.T) {
	f := newTaskReadFixture(t)
	a := readAuthorization(t, f, "task:read")
	root := taskReadID(1)
	app := f.graph(root, store.TaskPresence{Found: true}, []model.GraphTask{taskReadGraphTask(root, "Visible", model.TaskInProgress)})
	f.projectReader.ProjectFn = nil
	s := taskservice.NewScopedTasks(app, a)
	graph, err := s.GraphTaskOnly(f.ctx, f.principal, f.project.ID, root)
	if err != nil || graph.Project.ID != f.project.ID || graph.Project.Name != "" || graph.Project.RepoURL != "" || len(graph.Tasks) != 1 {
		t.Fatalf("minimal graph %#v %v", graph, err)
	}
	if _, err := s.Graph(f.ctx, f.principal, f.project.ID, root); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("full graph %v", err)
	}
	if _, err := taskservice.NewScopedTasks(app, readAuthorization(t, f, "project:read")).GraphTaskOnly(f.ctx, f.principal, f.project.ID, root); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("no task scope %v", err)
	}
}

func TestScopedTaskReadAdmissionAndRedaction(t *testing.T) {
	f := newTaskReadFixture(t)
	a := readAuthorization(t, f, "task:read")
	id := taskReadID(1)
	f.reader.TaskFn = func(context.Context, string, string) (model.Task, error) {
		return model.Task{ID: id, Properties: model.TaskProperties{"worker": propertyJSON(map[string]string{"nativeSessionId": "secret"}), "sessionStartup": propertyJSON(map[string]string{"sessionId": "secret"}), "blocked": propertyJSON(true)}}, nil
	}
	s := taskservice.NewScopedTasks(taskservice.NewTasks(f.store), a)
	got, err := s.Get(f.ctx, f.principal, f.project.ID, id)
	if err != nil || len(got.Properties) != 1 || string(got.Properties["blocked"]) != "true" {
		t.Fatalf("get %#v %v", got, err)
	}
	f.reader.TaskFn = nil
	s = taskservice.NewScopedTasks(taskservice.NewTasks(f.store), readAuthorization(t, f, "project:read"))
	if _, err := s.Get(f.ctx, f.principal, f.project.ID, id); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("scope refusal %v", err)
	}
}

func TestScopedSyncNoSessionKeepsEntireActiveTaskKeyset(t *testing.T) {
	f := newTaskReadFixture(t)
	a := readAuthorization(t, f, "project:read", "task:read")
	row := taskReadView(taskReadID(1), "Changed", 3, f.observed)
	row.Properties = model.TaskProperties{"worker": propertyJSON(map[string]string{"nativeSessionId": "private"}), "blocked": propertyJSON(true)}
	f.sync(taskReadID(90), func(*time.Time) ([]model.TaskViewRecord, error) { return []model.TaskViewRecord{row}, nil }, nil, time.Second)
	f.snapshot.SessionDAOFn = nil
	active := make([]store.TaskSyncTaskIdentity, 201)
	for i := range active {
		active[i] = store.TaskSyncTaskIdentity{ID: taskReadID(i + 1), Version: int64(i + 3)}
	}
	f.reader.TaskSyncActiveTasksFn = func(context.Context, string) ([]store.TaskSyncTaskIdentity, error) { return active, nil }
	s := taskservice.NewScopedTaskSync(taskservice.NewTaskSync(f.store, nil, time.Second), a)
	got, err := s.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{})
	if err != nil || !got.SessionPartial || len(got.TaskObservations) != 201 || len(got.Sessions) != 0 || len(got.Tasks) != 1 || len(got.Tasks[0].Properties) != 1 {
		t.Fatalf("sync %#v %v", got, err)
	}
	for _, v := range active {
		obs, ok := got.TaskObservations[v.ID]
		if !ok || obs.TaskVersion != v.Version || obs.State != "unavailable" || obs.ObservedAt != nil || obs.FreshUntil != nil || obs.CanOpen {
			t.Fatalf("observation %#v %v", obs, ok)
		}
	}
	if got.ResponseSessionAt.IsZero() || got.ResponseTaskAt.IsZero() || f.reads != 1 {
		t.Fatalf("sync clocks/snapshots %#v reads=%d", got, f.reads)
	}
	s = taskservice.NewScopedTaskSync(taskservice.NewTaskSync(f.store, nil, time.Second), readAuthorization(t, f, "task:read"))
	if _, err := s.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{}); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("project scope refusal %v", err)
	}
}
