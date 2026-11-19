package webhook

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testPersonalDeliveryDestinationsFilterOwnerAndOrigin(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := t.Context()
	var event string
	if err := f.conn.QueryRow(ctx, `SELECT event_id::text FROM webhook_deliveries WHERE id=$1`, f.delivery).Scan(&event); err != nil {
		t.Fatal(err)
	}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	d := New(tx)
	// Capture copies the endpoint origin with its configured host case.
	if _, err := tx.Exec(ctx, `UPDATE webhook_deliveries SET destination_origin='https://Example.TEST' WHERE id=$1`, f.delivery); err != nil {
		t.Fatal(err)
	}
	for _, after := range []string{"", "00000000-0000-0000-0000-000000000000"} {
		got, err := d.PersonalDeliveryDestinations(ctx, event, f.user, "https://example.test", after, 10)
		if err != nil || len(got) != 1 || got[0].DeliveryID != f.delivery || !bytes.Equal(got[0].Configuration, sampleDestination()) {
			t.Fatalf("owner destinations after %q = %+v err=%v", after, got, err)
		}
	}
	type page = []store.WebhookDeliveryDestination
	for name, read := range map[string]func() (page, error){
		"other owner": func() (page, error) {
			return d.PersonalDeliveryDestinations(ctx, event, uuid.NewString(), "https://example.test", "", 10)
		},
		"other origin": func() (page, error) {
			return d.PersonalDeliveryDestinations(ctx, event, f.user, "https://other.test", "", 10)
		},
		"other event": func() (page, error) {
			return d.PersonalDeliveryDestinations(ctx, uuid.NewString(), f.user, "https://example.test", "", 10)
		},
		"malformed id": func() (page, error) {
			return d.PersonalDeliveryDestinations(ctx, "event", f.user, "https://example.test", "", 10)
		},
		"after last": func() (page, error) {
			return d.PersonalDeliveryDestinations(ctx, event, f.user, "https://example.test", f.delivery, 10)
		},
		"malformed after": func() (page, error) {
			return d.PersonalDeliveryDestinations(ctx, event, f.user, "https://example.test", "after", 10)
		},
		"zero limit": func() (page, error) {
			return d.PersonalDeliveryDestinations(ctx, event, f.user, "https://example.test", "", 0)
		},
	} {
		if got, err := read(); err != nil || len(got) != 0 {
			t.Fatalf("%s: %q err=%v", name, got, err)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = d.PersonalDeliveryDestinations(cancelled, event, f.user, "https://example.test", "", 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled read err=%v", err)
	}
}
