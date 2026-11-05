package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestOpenAttachmentMaintenanceOwnsLockUntilClose(t *testing.T) {
	url := serviceDatabaseURL(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	first, err := OpenAttachmentMaintenance(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close(context.Background())

	blockedCtx, blockedCancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer blockedCancel()
	_, err = OpenAttachmentMaintenance(blockedCtx, url)
	var failure *store.AttachmentMaintenanceError
	if !errors.As(err, &failure) || failure.Stage != store.AttachmentMaintenanceLock || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second session did not wait for the lock: %v", err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	second, err := OpenAttachmentMaintenance(ctx, url)
	if err != nil {
		t.Fatalf("lock unavailable after close: %v", err)
	}
	if err := second.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
