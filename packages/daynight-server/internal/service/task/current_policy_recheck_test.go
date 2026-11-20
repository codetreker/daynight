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
