package webhook

import (
	"context"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

type advancedSnapshotDatabase struct {
	*postgres.Store
	advance  func() error
	advanced atomic.Bool
}

func (d *advancedSnapshotDatabase) ReadSnapshot(ctx context.Context, callback func(store.SnapshotScope) error) error {
	if err := d.Store.ReadSnapshot(ctx, callback); err != nil {
		return err
	}
	if d.advanced.CompareAndSwap(false, true) {
		return d.advance()
	}
	return nil
}

func TestAnticipatedVersionCannotUseAnOlderSourceLockPreimage(t *testing.T) {
	h := newIntegrationHarness(t)
	base := "/api/v1/teams/" + h.team.ID + "/webhooks"
	created := decoded[mutationResponse](t, h.call("POST", base, body(t, createBody(h, h.alice)), h.aliceCookie), 201)
	endpoint := decodeEndpoint(t, created.Endpoint)
	path := base + "/" + endpoint.ID
	for version := 1; version < 3; version++ {
		input := h.newOperation(h.alice)
		input["ifVersion"], input["name"] = strconv.Itoa(version), "Revision "+strconv.Itoa(version+1)
		changed := decoded[mutationResponse](t, h.call("PATCH", path, body(t, input), h.aliceCookie), 200)
		if changed.Operation.ConfigVersionAfter != strconv.Itoa(version+1) {
			t.Fatal("setup did not advance the stable source-lock preimage")
		}
	}
	selection := func(events []string) []any {
		return []any{map[string]any{"id": endpoint.Subscriptions[0].ID, "projectId": h.project.ID, "eventTypes": events}}
	}
	database := &advancedSnapshotDatabase{Store: h.Database}
	database.advance = func() error {
		input := h.newOperation(h.alice)
		input["ifVersion"], input["subscriptions"] = "3", selection([]string{"task.created"})
		changed := decoded[mutationResponse](t, h.call("PATCH", path, body(t, input), h.aliceCookie), 200)
		if changed.Operation.ConfigVersionAfter != "4" {
			t.Fatal("concurrent legitimate removal did not commit version four")
		}
		return nil
	}
	h.mount(t, database, h.keyring, true)
	anticipated := h.newOperation(h.alice)
	anticipated["ifVersion"], anticipated["subscriptions"] = "4", selection([]string{"task.created", "task.paused"})
	errorStatus(t, h.call("PATCH", path, body(t, anticipated), h.aliceCookie), 409, "version_conflict")
	if !database.advanced.Load() {
		t.Fatal("test did not preserve version three while committing version four")
	}
	current := decoded[endpointResponse](t, h.call("GET", path, "", h.aliceCookie), 200)
	if current.ConfigVersion != "4" || len(current.Subscriptions) != 1 || len(current.Subscriptions[0].EventTypes) != 1 || current.Subscriptions[0].EventTypes[0] != "task.created" {
		t.Fatal("anticipated version restored an unfenced binding")
	}
	var bindings, receipts int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT
        (SELECT count(*) FROM webhook_bindings b JOIN webhook_subscriptions s ON s.id=b.subscription_id WHERE s.endpoint_id=$1 AND b.event_type='task.paused' AND b.deleted_at IS NULL),
        (SELECT count(*) FROM webhook_operations WHERE owner_kind='team' AND owner_id=$2 AND operation_id=$3)`, endpoint.ID, h.team.ID, anticipated["operationId"]).Scan(&bindings, &receipts); err != nil || bindings != 0 || receipts != 0 {
		t.Fatal("rejected anticipated version persisted a binding or operation receipt")
	}
}
