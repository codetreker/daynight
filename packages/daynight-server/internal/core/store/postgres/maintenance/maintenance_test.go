package maintenance

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type maintenanceVisitor struct {
	identity                                               store.AttachmentMaintenanceIdentity
	projects                                               []store.AttachmentMaintenanceProject
	owners                                                 []store.AttachmentMaintenanceOwner
	metadata                                               []store.AttachmentMaintenanceMetadata
	identityError, projectError, ownerError, metadataError error
}

func (v *maintenanceVisitor) Identity(value store.AttachmentMaintenanceIdentity) error {
	v.identity = value
	return v.identityError
}
func (v *maintenanceVisitor) Project(value store.AttachmentMaintenanceProject) error {
	v.projects = append(v.projects, value)
	return v.projectError
}
func (v *maintenanceVisitor) Owner(value store.AttachmentMaintenanceOwner) error {
	v.owners = append(v.owners, value)
	return v.ownerError
}
func (v *maintenanceVisitor) Metadata(value store.AttachmentMaintenanceMetadata) error {
	v.metadata = append(v.metadata, value)
	return v.metadataError
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
	for _, tc := range []struct {
		name                       string
		visitor                    *maintenanceVisitor
		projects, owners, metadata int
	}{
		{"identity", &maintenanceVisitor{identityError: stop}, 0, 0, 0},
		{"project", &maintenanceVisitor{projectError: stop}, 1, 0, 0},
		{"owner", &maintenanceVisitor{ownerError: stop}, 1, 1, 0},
		{"metadata", &maintenanceVisitor{metadataError: stop}, 1, 1, 1},
	} {
		err := maintenance.Snapshot(ctx, tc.visitor)
		if err != stop || len(tc.visitor.projects) != tc.projects || len(tc.visitor.owners) != tc.owners || len(tc.visitor.metadata) != tc.metadata {
			t.Fatalf("%s callback did not stop inventory: %#v, error: %v", tc.name, tc.visitor, err)
		}
	}
	if err := maintenance.Snapshot(ctx, &maintenanceVisitor{}); err != nil {
		t.Fatalf("snapshot after callback rollback: %v", err)
	}
	checkLock(false)
	waitCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	_, err = OpenAttachmentMaintenance(waitCtx, url)
	var failure *store.AttachmentMaintenanceError
	if !errors.As(err, &failure) || failure.Stage != store.AttachmentMaintenanceLock || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting for lock: %v", err)
	}
	if err := maintenance.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	err = maintenance.Snapshot(ctx, &maintenanceVisitor{})
	if !errors.As(err, &failure) || failure.Stage != store.AttachmentMaintenanceSnapshotOpen {
		t.Fatalf("snapshot on closed session: %v", err)
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

func TestAttachmentMaintenanceSnapshotDatabaseFailures(t *testing.T) {
	const projects = `CREATE TABLE projects (id uuid)`
	const tasks = `CREATE TABLE tasks (id uuid, project_id uuid)`
	const metadata = `CREATE TABLE task_attachments (project_id uuid, task_id uuid, path text, size_bytes bigint)`
	cases := []struct {
		name       string
		statements []string
		stage      store.AttachmentMaintenanceStage
	}{
		{"missing relation", []string{projects, tasks}, store.AttachmentMaintenanceRelationsRead},
		{"project query", []string{`CREATE TABLE projects (other uuid)`, tasks, metadata}, store.AttachmentMaintenanceProjectsQuery},
		{"project decode", []string{projects, tasks, metadata, `INSERT INTO projects VALUES (NULL)`}, store.AttachmentMaintenanceProjectsDecode},
		{"task query", []string{projects, `CREATE TABLE tasks (id uuid)`, metadata}, store.AttachmentMaintenanceTasksQuery},
		{"task decode", []string{projects, tasks, metadata, `INSERT INTO tasks VALUES (NULL,NULL)`}, store.AttachmentMaintenanceTasksDecode},
		{"metadata query", []string{projects, tasks, `CREATE TABLE task_attachments (task_id uuid, project_id uuid, path text)`}, store.AttachmentMaintenanceMetadataQuery},
		{"metadata decode", []string{projects, tasks, metadata, `INSERT INTO task_attachments VALUES (NULL,NULL,'x',1)`}, store.AttachmentMaintenanceMetadataDecode},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			url := scopedDatabaseURL(t)
			setup, err := pgx.Connect(ctx, url)
			if err != nil {
				t.Fatal(err)
			}
			defer setup.Close(context.Background())
			for _, statement := range tc.statements {
				if _, err := setup.Exec(ctx, statement); err != nil {
					t.Fatal(err)
				}
			}
			maintenance, err := OpenAttachmentMaintenance(ctx, url)
			if err != nil {
				t.Fatal(err)
			}
			defer maintenance.Close(context.Background())
			err = maintenance.Snapshot(ctx, &maintenanceVisitor{})
			var failure *store.AttachmentMaintenanceError
			if !errors.As(err, &failure) || failure.Stage != tc.stage || failure.Cause == nil || errors.Unwrap(failure) != failure.Cause || !strings.Contains(failure.Error(), string(tc.stage)) {
				t.Fatalf("expected stage %s with cause; got %#v", tc.stage, err)
			}
		})
	}
}

func TestAttachmentMaintenanceOpenFailures(t *testing.T) {
	for _, tc := range []struct {
		name  string
		url   string
		stage store.AttachmentMaintenanceStage
	}{
		{"invalid configuration", "postgres://user:secret@bad%host/db", store.AttachmentMaintenanceConfig},
		{"connection failure", "postgres://user:secret@127.0.0.1:1/db?connect_timeout=1", store.AttachmentMaintenanceConnect},
	} {
		t.Run(tc.name, func(t *testing.T) {
			maintenance, err := OpenAttachmentMaintenance(t.Context(), tc.url)
			var failure *store.AttachmentMaintenanceError
			if maintenance != nil || !errors.As(err, &failure) || failure.Stage != tc.stage || failure.Cause == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("open returned %v, %v", maintenance, err)
			}
		})
	}
}
