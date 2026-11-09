package webhook

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type orphanEligibilityDAO struct {
	t      *testing.T
	ctx    context.Context
	filter store.WebhookEligibilityFilter
	row    store.WebhookAuthorization
	err    error
	calls  []string
}

func (d *orphanEligibilityDAO) LockAffected(ctx context.Context, filter store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	d.t.Helper()
	if ctx != d.ctx || filter != d.filter || len(d.calls) != 0 {
		d.t.Fatalf("affected subscriptions: context=%v filter=%#v calls=%v", ctx, filter, d.calls)
	}
	d.calls = append(d.calls, "lock")
	return []store.WebhookAuthorization{d.row}, nil
}

func (d *orphanEligibilityDAO) ReadEligibility(ctx context.Context, owner webhookmodel.Owner, projectID, actor string) (store.WebhookEligibility, error) {
	d.t.Helper()
	if ctx != d.ctx || owner != d.row.Owner || projectID != d.row.ProjectID || actor != "" || !reflect.DeepEqual(d.calls, []string{"lock"}) {
		d.t.Fatalf("eligibility lookup: context=%v owner=%#v project=%q actor=%q calls=%v", ctx, owner, projectID, actor, d.calls)
	}
	d.calls = append(d.calls, "read")
	return store.WebhookEligibility{}, d.err
}

func (d *orphanEligibilityDAO) Revoke(context.Context, string, int64) error {
	d.t.Helper()
	d.t.Fatal("ownership integrity failure must abort without revoking authorization")
	return nil
}

func TestRefreshEligibilityAbortsForOrphanedSubscribedProject(t *testing.T) {
	ctx := t.Context()
	owner := webhookmodel.Owner{Kind: "personal", ID: "member"}
	filter := store.WebhookEligibilityFilter{TeamID: "team", UserID: owner.ID}
	integrity := errors.New("live project ownership or owner Team missing")
	failure := fmt.Errorf("read orphaned project eligibility: %w", integrity)
	dao := &orphanEligibilityDAO{
		t: t, ctx: ctx, filter: filter,
		row: store.WebhookAuthorization{ID: "subscription", ProjectID: "project", Owner: owner, State: "active", Epoch: 1},
		err: failure,
	}
	err := RefreshEligibility(ctx, dao, filter)
	if err != failure || !errors.Is(err, integrity) || !reflect.DeepEqual(dao.calls, []string{"lock", "read"}) {
		t.Fatalf("ownership integrity failure: %v; calls=%v", err, dao.calls)
	}
}
