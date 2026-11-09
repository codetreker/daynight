package service

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestOpenAttachmentMaintenanceRetainsNativeOpenFailure(t *testing.T) {
	maintenance, err := OpenAttachmentMaintenance(t.Context(), "postgres://user:secret@bad%host/database")
	var failure *store.AttachmentMaintenanceError
	if maintenance != nil || !errors.As(err, &failure) || failure.Stage != store.AttachmentMaintenanceConfig || errors.Unwrap(failure) == nil {
		t.Fatalf("maintenance open failure: maintenance=%v error=%v", maintenance, err)
	}
}
