package task

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"testing"
	"time"
)

func TestTaskObservationRejectsPolicyRemovedDuringLiveSampling(t *testing.T) {
	for _, removed := range []scopepolicy.ScopeID{"session:read", "task:read"} {
		t.Run(string(removed), func(t *testing.T) {
			app, _, observer, db := workServiceFixture(t)
			initial := scopedObservationAuth(t, "session:read", "task:read")
			current := initial
			app.operations.task = func(context.Context, taskcore.ReadDAO, string, string) (model.Task, *model.Fault, error) {
				return observationTask(), nil, nil
			}
			observer.after = func() {
				if removed == "task:read" {
					current = scopedObservationAuth(t, "session:read")
				} else {
					current = scopedObservationAuth(t, "task:read")
				}
			}
			app = WithCurrentObservationAuthorization(app, func(_ context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
				if !db.active || p != initial.Principal {
					t.Fatal("policy not read in owning snapshot")
				}
				return current, nil
			})
			app = NewScopedObservations(app, initial)
			got, err := app.ObserveGet(t.Context(), initial.Principal, workProject, workGroup)
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || got.Session.SessionID != nil || got.Task.ID != "" {
				t.Fatalf("delivered revoked read %#v %v", got, err)
			}
		})
	}
}

type observedGraphProjectReader struct {
	store.ProjectReader
	reads int
}

func (r *observedGraphProjectReader) Project(context.Context, string) (model.Project, error) {
	r.reads++
	return model.Project{ID: workProject, Name: "Private project", RepoURL: "https://example.com/private/repository"}, nil
}

func TestObservedGraphRechecksCurrentProjectScopeForFullProjection(t *testing.T) {
	for _, test := range []struct {
		name         string
		taskOnly     bool
		withoutScope bool
		removeBefore bool
		removeDuring bool
		denied       bool
	}{
		{name: "full project remains permitted"},
		{name: "full project removed before admission", removeBefore: true, denied: true},
		{name: "full project removed during sampling", removeDuring: true, denied: true},
		{name: "task only without project scope", taskOnly: true, withoutScope: true},
		{name: "task only survives project scope removal", taskOnly: true, removeDuring: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app, _, observer, db := workServiceFixture(t)
			projects := &observedGraphProjectReader{}
			snapshot := db.snapshot.(workServiceSnapshot)
			snapshot.project = projects
			db.snapshot = snapshot
			initial := scopedObservationAuth(t, "project:read", "session:read", "task:read")
			restricted := scopedObservationAuth(t, "session:read", "task:read")
			if test.withoutScope {
				initial = restricted
			}
			current := initial
			if test.removeBefore {
				current = restricted
			}
			if test.removeDuring {
				observer.after = func() { current = restricted }
			}
			policyReads := 0
			app = WithCurrentObservationAuthorization(app, func(_ context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
				if !db.active || p != initial.Principal {
					t.Fatal("graph policy not read in owning snapshot")
				}
				policyReads++
				return current, nil
			})
			app.operations.graph = func(_ context.Context, _ taskcore.GraphReader, _ taskcore.SnapshotClock, _, root string, project model.Project) (model.TaskGraph, *model.Fault, error) {
				return model.TaskGraph{Project: project, Tasks: []model.GraphTask{{ID: root, Version: 1, Status: model.TaskInProgress}}}, nil, nil
			}
			app = NewScopedObservations(app, initial)
			read := app.ObserveGraph
			if test.taskOnly {
				read = app.ObserveGraphTaskOnly
			}
			got, err := read(t.Context(), initial.Principal, workProject, workGroup)
			if test.denied {
				if !errors.Is(err, scopepolicy.ErrInsufficientScope) || got.Graph.Project.ID != "" || len(got.Graph.Tasks) != 0 || len(got.Sessions) != 0 {
					t.Fatalf("delivered project after scope removal: %#v %v", got, err)
				}
			} else if err != nil || len(got.Graph.Tasks) != 1 || got.Sessions[workGroup].Observation != "observed" {
				t.Fatalf("graph projection: %#v %v", got, err)
			} else if test.taskOnly {
				if got.Graph.Project != (model.Project{ID: workProject}) || projects.reads != 0 {
					t.Fatalf("task-only graph read project settings: %#v reads=%d", got.Graph.Project, projects.reads)
				}
			} else if got.Graph.Project.Name != "Private project" || got.Graph.Project.RepoURL != "https://example.com/private/repository" {
				t.Fatalf("full project lost fields: %#v", got.Graph.Project)
			}
			wantPolicyReads, wantSamples := 2, 1
			if test.removeBefore {
				wantPolicyReads, wantSamples = 1, 0
				if projects.reads != 0 {
					t.Fatal("project content read before current-policy admission")
				}
			}
			if policyReads != wantPolicyReads || observer.calls != wantSamples {
				t.Fatalf("policy reads=%d samples=%d", policyReads, observer.calls)
			}
			// A full Graph requirement belongs to that call, including after refusal.
			current = restricted
			got, err = app.ObserveGraphTaskOnly(t.Context(), initial.Principal, workProject, workGroup)
			if err != nil || got.Graph.Project != (model.Project{ID: workProject}) {
				t.Fatalf("full Graph requirement escaped its request: %#v %v", got, err)
			}
		})
	}
}
func TestPersonalInventoryRejectsPolicyRemovedDuringLiveSampling(t *testing.T) {
	app, _, _, observer, db, _ := personalFixture(t)
	initial := scopedObservationAuth(t, "session:read", "task:read")
	initial.Principal = personalPrincipal()
	current := initial
	observer.after = func() { current = scopedObservationAuth(t, "task:read"); current.Principal = initial.Principal }
	app = WithCurrentObservationAuthorization(app, func(_ context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		if !db.active || p != initial.Principal {
			t.Fatal("policy outside owning snapshot")
		}
		return current, nil
	})
	app = NewScopedObservations(app, initial)
	got, err := app.PersonalTasks(t.Context(), initial.Principal, 0, nil)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || len(got.Items) != 0 {
		t.Fatalf("delivered revoked personal projection %#v %v", got, err)
	}
}
func TestTaskSyncRejectsCurrentPolicyWithoutSampledSessionScope(t *testing.T) {
	f := newSyncFixture(t, 1)
	initial := scopedObservationAuth(t, "project:read", "session:read", "task:read")
	initial.Principal = syncPrincipal
	restricted := scopedObservationAuth(t, "project:read", "task:read")
	restricted.Principal = syncPrincipal
	app := WithCurrentSyncAuthorization(NewTaskSync(f, f, time.Second), func(_ context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		if !f.active || f.snapshot != 2 || p != syncPrincipal {
			t.Fatal("sync policy outside final snapshot")
		}
		return restricted, nil
	})
	app = NewScopedTaskSync(app, initial)
	since := workTime.Add(-time.Hour)
	got, err := app.Get(f.ctx, syncPrincipal, syncProjectID, TaskSyncRequest{Epoch: syncEpoch, Since: &since})
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || len(got.Sessions) != 0 {
		t.Fatalf("delivered revoked sync %#v %v", got, err)
	}
}
