package webhook

import (
	"context"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestSubscriptionPlanningRejectsPredictedConfigurationVersion(t *testing.T) {
	f := newMgmtFixture(t)
	planned := f.endpoint
	planned.ConfigVersion = 3
	f.endpoint = planned
	locked := planned
	locked.ConfigVersion = 4
	locked.UpdatedAt = f.now.Add(-time.Minute)
	subscription, bindings := mgmtSubscription(f)
	mgmtInstallSubscriptions(f, []wm.Subscription{subscription}, map[string][]wm.Binding{subscription.ID: bindings[:1]})
	plannedReads := 0
	f.writer.EndpointFn = func(_ context.Context, owner wm.Owner, id string) (wm.Endpoint, error) {
		mgmtWantEqual(t, owner, f.owner)
		mgmtWantEqual(t, id, planned.ID)
		plannedReads++
		if plannedReads != 1 {
			f.writer.need("extra planning read", false)
		}
		return planned, nil
	}
	f.writer.LockEndpointFn = func(_ context.Context, owner wm.Owner, id string) (wm.Endpoint, error) {
		mgmtWantEqual(t, owner, f.owner)
		mgmtWantEqual(t, id, locked.ID)
		return locked, nil
	}

	m := f.mutation("endpoint.update")
	m.IfVersion = 4
	m.HasSubscriptions = true
	m.Subscriptions = []core.SubscriptionInput{mgmtSubscriptionInput(subscription, "task.created", "task.paused")}

	// The complete accepted projection keeps a faulty CAS policy observable as
	// a business result, including restoration of the removed event binding.
	restored := wm.Binding{ID: mgmtRandomID(0), SubscriptionID: subscription.ID, EventType: "task.paused", CreatedAt: f.now}
	accepted := locked
	accepted.ConfigVersion = 5
	accepted.UpdatedAt = f.now
	mgmtSubscriptionResponse(f, m, accepted, "applied", []wm.Subscription{subscription}, map[string][]wm.Binding{subscription.ID: {bindings[0], restored}})
	f.recordWrites()
	result, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
	mgmtWantFault(t, err, "version_conflict")
	if result.Body != nil || result.Replay {
		t.Fatalf("predicted version produced a result: %#v", result)
	}
	if plannedReads != 1 {
		t.Fatalf("planned version was not read: %d", plannedReads)
	}
	f.noEffects()
}
