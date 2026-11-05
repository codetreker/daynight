package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type maintenanceVisitor struct {
	identity   AttachmentMaintenanceIdentity
	projects   []AttachmentMaintenanceProject
	owners     []AttachmentMaintenanceOwner
	metadata   []AttachmentMaintenanceMetadata
	ownerError error
}

func (v *maintenanceVisitor) Identity(value AttachmentMaintenanceIdentity) error {
	v.identity = value
	return nil
}
func (v *maintenanceVisitor) Project(value AttachmentMaintenanceProject) error {
	v.projects = append(v.projects, value)
	return nil
}
func (v *maintenanceVisitor) Owner(value AttachmentMaintenanceOwner) error {
	v.owners = append(v.owners, value)
	return v.ownerError
}
func (v *maintenanceVisitor) Metadata(value AttachmentMaintenanceMetadata) error {
	v.metadata = append(v.metadata, value)
	return nil
}

func TestAttachmentMaintenanceKeepsLockAcrossSnapshots(t *testing.T) {
	url := scopedDatabaseURL(t)
	ctx := t.Context()
	setup, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Close(context.Background())
	_, err = setup.Exec(ctx, `CREATE TABLE projects (id uuid PRIMARY KEY);
		CREATE TABLE tasks (id uuid PRIMARY KEY, project_id uuid);
		CREATE TABLE task_attachments (project_id uuid, task_id uuid, path text, size_bytes bigint);
		INSERT INTO projects VALUES ('00000000-0000-4000-8000-000000000001');
		INSERT INTO tasks VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
		INSERT INTO task_attachments VALUES
		 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','z',1),
		 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','a',2)`)
	if err != nil {
		t.Fatal(err)
	}
	maintenance, err := OpenAttachmentMaintenance(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer maintenance.Close(context.Background())
	checkLock := func(want bool) {
		t.Helper()
		var acquired bool
		if err := setup.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", attachmentMaintenanceLock).Scan(&acquired); err != nil || acquired != want {
			t.Fatalf("lock acquired = %v, error = %v; want %v", acquired, err, want)
		}
	}
	checkLock(false)
	first := &maintenanceVisitor{}
	if err := maintenance.Snapshot(ctx, first); err != nil {
		t.Fatal(err)
	}
	if first.identity.Host == "" || first.identity.Port == "" || first.identity.Database == "" || first.identity.DatabaseOID == "" || first.identity.Schema == "" || len(first.identity.Relations) != 3 {
		t.Fatalf("incomplete identity: %#v", first.identity)
	}
	if len(first.projects) != 1 || len(first.owners) != 1 || len(first.metadata) != 2 || first.metadata[0].Path != "a" || first.metadata[1].Path != "z" || !strings.Contains(first.metadata[0].Data, `"size_bytes": 2`) {
		t.Fatalf("unexpected inventory: %#v", first)
	}
	if _, err := setup.Exec(ctx, `UPDATE task_attachments SET size_bytes=3 WHERE path='a'`); err != nil {
		t.Fatal(err)
	}
	second := &maintenanceVisitor{}
	err = maintenance.Snapshot(ctx, second)
	if err != nil || len(second.metadata) != 2 || second.metadata[0].SizeBytes != 3 || second.metadata[0].Data == first.metadata[0].Data {
		t.Fatalf("fresh snapshot: %#v, error: %v", second, err)
	}
	stop := errors.New("stop inventory")
	stopped := &maintenanceVisitor{ownerError: stop}
	if err := maintenance.Snapshot(ctx, stopped); err != stop || len(stopped.owners) != 1 || len(stopped.metadata) != 0 {
		t.Fatalf("callback did not stop inventory: %#v, error: %v", stopped, err)
	}
	if err := maintenance.Snapshot(ctx, &maintenanceVisitor{}); err != nil {
		t.Fatalf("snapshot after callback rollback: %v", err)
	}
	checkLock(false)
	waitCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	_, err = OpenAttachmentMaintenance(waitCtx, url)
	var failure *AttachmentMaintenanceError
	if !errors.As(err, &failure) || failure.Stage != AttachmentMaintenanceLock || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting for lock: %v", err)
	}
	if err := maintenance.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	releaseCtx, releaseCancel := context.WithTimeout(ctx, 30*time.Second)
	defer releaseCancel()
	if _, err := setup.Exec(releaseCtx, "SELECT pg_advisory_lock($1)", attachmentMaintenanceLock); err != nil {
		t.Fatalf("lock was not released: %v", err)
	}
	if _, err := setup.Exec(ctx, "SELECT pg_advisory_unlock($1)", attachmentMaintenanceLock); err != nil {
		t.Fatal(err)
	}
}
