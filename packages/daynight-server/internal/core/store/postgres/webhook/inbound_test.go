package webhook

import (
	"bytes"
	"context"
	"errors"
	"testing"

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
	got, err := d.PersonalDeliveryDestinations(ctx, event, f.user, "https://example.test", 10)
	if err != nil || len(got) != 1 || !bytes.Equal(got[0], sampleDestination()) {
		t.Fatalf("owner destinations = %q err=%v", got, err)
	}
	for name, read := range map[string]func() ([][]byte, error){
		"other owner": func() ([][]byte, error) {
			return d.PersonalDeliveryDestinations(ctx, event, uuid.NewString(), "https://example.test", 10)
		},
		"other origin": func() ([][]byte, error) {
			return d.PersonalDeliveryDestinations(ctx, event, f.user, "https://other.test", 10)
		},
		"other event": func() ([][]byte, error) {
			return d.PersonalDeliveryDestinations(ctx, uuid.NewString(), f.user, "https://example.test", 10)
		},
		"malformed id": func() ([][]byte, error) {
			return d.PersonalDeliveryDestinations(ctx, "event", f.user, "https://example.test", 10)
		},
		"zero limit": func() ([][]byte, error) {
			return d.PersonalDeliveryDestinations(ctx, event, f.user, "https://example.test", 0)
		},
	} {
		if got, err := read(); err != nil || len(got) != 0 {
			t.Fatalf("%s: %q err=%v", name, got, err)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = d.PersonalDeliveryDestinations(cancelled, event, f.user, "https://example.test", 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled read err=%v", err)
	}
}
