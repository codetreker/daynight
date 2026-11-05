package service

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestOpenAttachmentMaintenanceOwnsLockUntilClose(t *testing.T) {
	url := serviceDatabaseURL(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	contender, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer contender.Close(context.Background())
	first, err := OpenAttachmentMaintenance(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close(context.Background())

	const maintenanceLock int64 = 0x444e4154544c4159
	var acquired bool
	if err := contender.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", maintenanceLock).Scan(&acquired); err != nil || acquired {
		t.Fatalf("lock while maintenance is open: acquired=%v, error=%v", acquired, err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := contender.Exec(ctx, "SELECT pg_advisory_lock($1)", maintenanceLock); err != nil {
		t.Fatalf("lock unavailable after close: %v", err)
	}
	if _, err := contender.Exec(ctx, "SELECT pg_advisory_unlock($1)", maintenanceLock); err != nil {
		t.Fatal(err)
	}
}
