package attachment

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment/migration"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type maintenanceFixture struct {
	closed    bool
	snapshots int
}

func (f *maintenanceFixture) Snapshot(_ context.Context, visitor store.AttachmentMaintenanceVisitor) error {
	f.snapshots++
	return visitor.Identity(store.AttachmentMaintenanceIdentity{Host: "localhost", Port: "5432", Database: "fixture", DatabaseOID: "1", Schema: "public", Relations: map[string]string{"projects": "public/1", "tasks": "public/2", "task_attachments": "public/3"}})
}
func (f *maintenanceFixture) Close(ctx context.Context) error {
	f.closed = ctx.Err() == nil
	return nil
}

func TestMigrateAttachmentLayoutAssembly(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	root := t.TempDir()
	cause := errors.New("underlying database failure")
	cases := []struct {
		name, databaseURL, root, action, id string
		openErr                             error
		category, diagnostic                string
		wantOpen, wantClose                 bool
	}{
		{name: "invalid action first", action: "invalid", category: "invalid_input", diagnostic: "Migration action must be plan, apply, or resume."},
		{name: "invalid operation first", action: "resume", id: "bad", category: "invalid_input", diagnostic: "A valid migration operation ID is required."},
		{name: "plan rejects operation", action: "plan", id: "not-empty", category: "invalid_input", diagnostic: "A new migration plan cannot specify an operation ID."},
		{name: "missing database", databaseURL: " ", root: root, action: "plan", category: "configuration", diagnostic: "DAYNIGHT_DATABASE_URL and DAYNIGHT_STORAGE_ROOT are required."},
		{name: "missing root", databaseURL: "db", root: " ", action: "plan", category: "configuration", diagnostic: "DAYNIGHT_DATABASE_URL and DAYNIGHT_STORAGE_ROOT are required."},
		{name: "open failure", databaseURL: "db", root: root, action: "plan", openErr: &store.AttachmentMaintenanceError{Stage: store.AttachmentMaintenanceLock, Cause: cause}, category: "database", diagnostic: "Migration ownership lock failed.", wantOpen: true},
		{name: "root failure", databaseURL: "db", root: filepath.Join(root, "missing"), action: "plan", category: "filesystem", diagnostic: "Migration storage root could not be opened.", wantOpen: true, wantClose: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &maintenanceFixture{}
			called := false
			open := func(_ context.Context, gotURL string) (store.AttachmentMaintenance, error) {
				called = true
				if gotURL != tc.databaseURL {
					t.Fatalf("database URL = %q", gotURL)
				}
				if tc.openErr != nil {
					return nil, tc.openErr
				}
				return fake, nil
			}
			_, err := MigrateAttachmentLayout(t.Context(), tc.databaseURL, tc.root, tc.action, tc.id, logger, open)
			var failure *migration.AttachmentMigrationError
			if !errors.As(err, &failure) || failure.Category != tc.category || failure.Diagnostic != tc.diagnostic || failure.Phase != "configuration" {
				t.Fatalf("unexpected failure: %#v", err)
			}
			if tc.openErr != nil && !errors.Is(err, cause) {
				t.Fatalf("cause lost: %v", err)
			}
			if called != tc.wantOpen || fake.closed != tc.wantClose || fake.snapshots != 0 {
				t.Fatalf("open=%v close=%v snapshots=%d", called, fake.closed, fake.snapshots)
			}
		})
	}
}

func TestMigrateAttachmentLayoutPlansAndCloses(t *testing.T) {
	root := t.TempDir()
	fake := &maintenanceFixture{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	summary, err := MigrateAttachmentLayout(t.Context(), "db", root, "plan", "", logger, func(_ context.Context, _ string) (store.AttachmentMaintenance, error) { return fake, nil })
	if err != nil {
		t.Fatal(err)
	}
	if summary.OperationID == "" || summary.Phase != "planned" || summary.ReceiptPath != nil || fake.snapshots != 1 || !fake.closed {
		t.Fatalf("summary=%#v snapshots=%d closed=%v", summary, fake.snapshots, fake.closed)
	}
	if _, err := os.Stat(filepath.Join(root, summary.ManifestPath)); err != nil {
		t.Fatalf("manifest: %v", err)
	}
}
