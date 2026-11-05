package migration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type fixtureSnapshot struct {
	Identity store.AttachmentMaintenanceIdentity
	Projects []store.AttachmentMaintenanceProject
	Owners   []store.AttachmentMaintenanceOwner
	Metadata []store.AttachmentMaintenanceMetadata
}
type fixtureMaintenance struct{ snapshot fixtureSnapshot }

func (f fixtureMaintenance) Snapshot(_ context.Context, visitor store.AttachmentMaintenanceVisitor) error {
	if err := visitor.Identity(f.snapshot.Identity); err != nil {
		return err
	}
	for _, row := range f.snapshot.Projects {
		if err := visitor.Project(row); err != nil {
			return err
		}
	}
	for _, row := range f.snapshot.Owners {
		if err := visitor.Owner(row); err != nil {
			return err
		}
	}
	for _, row := range f.snapshot.Metadata {
		if err := visitor.Metadata(row); err != nil {
			return err
		}
	}
	return nil
}
func (f fixtureMaintenance) Close(context.Context) error { return nil }

type fixtureTask struct{ ID string }

func migrationRecordFixture(t *testing.T) (string, fixtureTask, fixtureMaintenance, AttachmentMigrationSummary) {
	t.Helper()
	task := fixtureTask{ID: "00000000-0000-0000-0000-000000000002"}
	project := "00000000-0000-0000-0000-000000000001"
	database := fixtureMaintenance{snapshot: fixtureSnapshot{
		Identity: store.AttachmentMaintenanceIdentity{Host: "host", Port: "5432", Database: "db", DatabaseOID: "1", Schema: "public", Relations: map[string]string{"projects": "public/1", "tasks": "public/2", "task_attachments": "public/3"}},
		Projects: []store.AttachmentMaintenanceProject{{ID: project, Data: "project"}},
		Owners:   []store.AttachmentMaintenanceOwner{{ProjectID: project, TaskID: task.ID, Data: "task"}},
		Metadata: []store.AttachmentMaintenanceMetadata{{ProjectID: project, TaskID: task.ID, Path: "file.bin", SizeBytes: 3, Data: "attachment"}},
	}}
	root := t.TempDir()
	name := filepath.Join(root, attachmentcore.Bucket, task.ID, "file.bin")
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte{0, 255, 1}, 0600); err != nil {
		t.Fatal(err)
	}
	opened, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	result, err := Run(t.Context(), database, opened, "plan", "", slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return root, task, database, result
}

type attachmentMigrationIntegrationEvent struct {
	Step string `json:"step"`
}
type fixtureLog struct {
	t      *testing.T
	notify func(attachmentMigrationIntegrationEvent)
}

func (l fixtureLog) Write(data []byte) (int, error) {
	var event attachmentMigrationIntegrationEvent
	if err := json.Unmarshal(data, &event); err != nil {
		l.t.Fatal(err)
	}
	l.notify(event)
	return len(data), nil
}
func attachmentMigrationIntegrationLogger(t *testing.T, notify func(attachmentMigrationIntegrationEvent)) *slog.Logger {
	return slog.New(slog.NewJSONHandler(fixtureLog{t, notify}, nil))
}

func TestAttachmentMigrationFilesystemFailuresPreserveExistingContent(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "source"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "source", "preserved"), []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "occupied"), []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	opened, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			if err := opened.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	m := &attachmentMigration{root: opened, phase: "placing"}
	assertFailure := func(err error, category string, cause error) {
		t.Helper()
		var failure *AttachmentMigrationError
		if !errors.As(err, &failure) || failure.Category != category || cause != nil && !errors.Is(err, cause) || strings.Contains(err.Error(), root) {
			t.Fatalf("filesystem failure lost its category/cause or exposed a host path: %v", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = m.readDirectory(ctx, ".")
	assertFailure(err, "canceled", context.Canceled)
	_, err = m.readDirectory(context.Background(), "missing")
	assertFailure(err, "filesystem", fs.ErrNotExist)
	_, err = m.readDirectory(context.Background(), "occupied")
	assertFailure(err, "filesystem", nil)
	assertFailure(m.syncDirectory("missing"), "filesystem", fs.ErrNotExist)
	assertFailure(m.makeParents("occupied/child"), "unsafe_entry", nil)
	assertFailure(m.rename(context.Background(), "source", "occupied"), "target_conflict", nil)
	assertFailure(m.rename(context.Background(), "missing", "new-target"), "filesystem", fs.ErrNotExist)
	_, err = m.writeJSON("occupied", attachmentMigrationState{Phase: "planned"}, false)
	assertFailure(err, "operation_conflict", nil)
	_, err = m.writeJSON("missing/record.json", attachmentMigrationState{Phase: "planned"}, false)
	assertFailure(err, "filesystem", fs.ErrNotExist)
	if err := opened.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	assertFailure(m.rename(context.Background(), "source", "new-target"), "filesystem", nil)
	_, err = m.writeJSON("record.json", attachmentMigrationState{Phase: "planned"}, false)
	assertFailure(err, "filesystem", nil)
	for name, expected := range map[string]string{"source/preserved": "source", "occupied": "target"} {
		if actual, err := os.ReadFile(filepath.Join(root, name)); err != nil || string(actual) != expected {
			t.Fatalf("failed filesystem operation modified %s: %q %v", name, actual, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "new-target")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("failed rename created a target: %v", err)
	}
}

func TestAttachmentMigrationCanceledHashReaderDoesNotConsumeContent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	content := strings.NewReader("preserved content")
	reader := attachmentMigrationReader{ctx: ctx, reader: content}
	buffer := []byte("unchanged")
	n, err := reader.Read(buffer)
	if n != 0 || !errors.Is(err, context.Canceled) || string(buffer) != "unchanged" || content.Len() != len("preserved content") {
		t.Fatalf("canceled verification consumed content: n=%d err=%v buffer=%q remaining=%d", n, err, buffer, content.Len())
	}
}

func TestAttachmentMigrationUnpublishedInitializationFailuresCanBeReplanned(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		step     string
		category string
		cause    error
	}{
		{"canceled before initialization", "", "canceled", context.Canceled},
		{"preexisting private directory", "", "filesystem", fs.ErrExist},
		{"manifest parent disappeared", "plan_initializing", "filesystem", fs.ErrNotExist},
		{"initial stage occupied", "plan_initializing", "operation_conflict", nil},
		{"root closed before manifest", "plan_initializing", "filesystem", nil},
		{"root closed before promotion", "plan_prepared", "filesystem", nil},
		{"prepared source disappeared", "plan_prepared", "filesystem", fs.ErrNotExist},
		{"official destination occupied", "plan_prepared", "operation_conflict", nil},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root, task, database, original := migrationRecordFixture(t)
			official := filepath.Join(root, attachmentMigrationPrefix+original.OperationID)
			data, err := os.ReadFile(filepath.Join(official, "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			var manifest attachmentMigrationManifest
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
			holding := filepath.Join(root, "preserved-previous-plan")
			if err := os.Rename(official, holding); err != nil {
				t.Fatal(err)
			}
			pending := filepath.Join(root, attachmentMigrationPendingPrefix+original.OperationID)
			opened, err := os.OpenRoot(root)
			if err != nil {
				t.Fatal(err)
			}
			closed := false
			t.Cleanup(func() {
				if !closed {
					if err := opened.Close(); err != nil {
						t.Error(err)
					}
				}
			})
			observed := false
			logger := attachmentMigrationIntegrationLogger(t, func(event attachmentMigrationIntegrationEvent) {
				if event.Step != scenario.step || observed {
					return
				}
				observed = true
				switch scenario.name {
				case "manifest parent disappeared":
					err = os.Remove(pending)
				case "initial stage occupied":
					err = os.Mkdir(filepath.Join(pending, "state.json"), 0o700)
				case "root closed before manifest", "root closed before promotion":
					err = opened.Close()
					closed = true
				case "prepared source disappeared":
					err = os.RemoveAll(pending)
				case "official destination occupied":
					if err = os.Mkdir(official, 0o700); err == nil {
						err = os.WriteFile(filepath.Join(official, "foreign"), []byte("not owned by initialization"), 0o600)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
			})
			m := &attachmentMigration{root: opened, logger: logger, operation: original.OperationID, phase: "inventory"}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch scenario.name {
			case "canceled before initialization":
				cancel()
			case "preexisting private directory":
				if err := os.Mkdir(pending, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(pending, "foreign"), []byte("preexisting private data"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			err = m.initializePlan(ctx, manifest)
			var failure *AttachmentMigrationError
			if !errors.As(err, &failure) || failure.Category != scenario.category || scenario.cause != nil && !errors.Is(err, scenario.cause) {
				t.Fatalf("unpublished initialization lost its original failure: %v", err)
			}
			if scenario.step != "" && !observed {
				t.Fatalf("initialization lifecycle boundary %s was not observed", scenario.step)
			}
			if closed && !strings.Contains(err.Error(), "unpublished migration directory could not be removed") {
				t.Fatalf("failed cleanup was hidden: %v", err)
			}
			if scenario.name == "official destination occupied" {
				if actual, err := os.ReadFile(filepath.Join(official, "foreign")); err != nil || string(actual) != "not owned by initialization" {
					t.Fatalf("failed promotion removed an unknown destination: %q %v", actual, err)
				}
				if err := os.RemoveAll(official); err != nil {
					t.Fatal(err)
				}
			} else if _, err := os.Stat(official); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("unpublished initialization exposed an official operation: %v", err)
			}
			if scenario.name == "preexisting private directory" {
				if actual, err := os.ReadFile(filepath.Join(pending, "foreign")); err != nil || string(actual) != "preexisting private data" {
					t.Fatalf("initialization cleaned a private directory it did not create: %q %v", actual, err)
				}
			} else if !closed {
				if _, err := os.Stat(pending); !errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("failed initialization retained its owned temporary directory: %v", err)
				}
			}
			actual, err := os.ReadFile(filepath.Join(root, attachmentcore.Bucket, task.ID, "file.bin"))
			if err != nil || !bytes.Equal(actual, []byte{0, 255, 1}) {
				t.Fatalf("plan initialization changed legacy bytes: %v %v", actual, err)
			}
			retryRoot, err := os.OpenRoot(root)
			if err != nil {
				t.Fatal(err)
			}
			defer retryRoot.Close()
			retry, err := Run(t.Context(), database, retryRoot, "plan", "", slog.New(slog.NewJSONHandler(io.Discard, nil)))
			if err != nil || retry.OperationID == original.OperationID || retry.Phase != "planned" {
				t.Fatalf("a failed unpublished attempt prevented a new plan: %+v %v", retry, err)
			}
			retryData, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(retry.ManifestPath)))
			var retryManifest attachmentMigrationManifest
			if err != nil || json.Unmarshal(retryData, &retryManifest) != nil || retryManifest.DatabaseDigest != manifest.DatabaseDigest {
				t.Fatalf("initialization failure changed database metadata: %s %v", retryData, err)
			}
			if actual, err := os.ReadFile(filepath.Join(holding, "manifest.json")); err != nil || !bytes.Equal(actual, data) {
				t.Fatalf("initialization cleaned an unrelated root entry: %v", err)
			}
		})
	}
}

type failedMaintenance struct {
	snapshot fixtureSnapshot
	err      error
}

func (f failedMaintenance) Snapshot(ctx context.Context, visitor store.AttachmentMaintenanceVisitor) error {
	if err := (fixtureMaintenance{f.snapshot}).Snapshot(ctx, visitor); err != nil {
		return err
	}
	return f.err
}
func (f failedMaintenance) Close(context.Context) error { return nil }

func TestSnapshotPreservesPersistedFingerprintAndDigest(t *testing.T) {
	data := fixtureSnapshot{
		Identity: store.AttachmentMaintenanceIdentity{Host: "db-host", Port: "5432", Database: "db", DatabaseOID: "42", Schema: "public", Relations: map[string]string{"projects": "public/1", "tasks": "public/2", "task_attachments": "public/3"}},
		Projects: []store.AttachmentMaintenanceProject{{ID: "p", Data: `{"id":"p"}`}},
		Owners:   []store.AttachmentMaintenanceOwner{{ProjectID: "p", TaskID: "t", Data: `{"id":"t"}`}},
		Metadata: []store.AttachmentMaintenanceMetadata{{ProjectID: "p", TaskID: "t", Path: "file.bin", SizeBytes: 3, Data: `{"path":"file.bin"}`}},
	}
	m := &attachmentMigration{database: fixtureMaintenance{data}, phase: "inventory"}
	got, err := m.snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if got.identity.Fingerprint != "12011897882dda8952d5fe37729368f3eb102a77c1bea875a79a0e98aba892cd" || got.digest != "64f1fe69e03368c7207abfc7d8ddca3dd454a3ed8d9472c2aed6a2d7043c8873" {
		t.Fatalf("persisted identity or digest changed: %+v %s", got.identity, got.digest)
	}
	if len(got.owners) != 1 || got.owners[0].ProjectID != "p" || len(got.metadata) != 1 || got.metadata[0].Data != data.Metadata[0].Data {
		t.Fatalf("inventory changed: %+v", got)
	}
}

func TestSnapshotReportsObservedInvalidInventoryBeforeLaterDatabaseFailure(t *testing.T) {
	cause := errors.New("database failure")
	data := fixtureSnapshot{Projects: []store.AttachmentMaintenanceProject{{ID: "p"}}, Owners: []store.AttachmentMaintenanceOwner{{ProjectID: "missing", TaskID: "t"}}}
	m := &attachmentMigration{database: failedMaintenance{data, &store.AttachmentMaintenanceError{Stage: store.AttachmentMaintenanceSnapshotCommit, Cause: cause}}, phase: "inventory"}
	_, err := m.snapshot(t.Context())
	var failure *AttachmentMigrationError
	if !errors.As(err, &failure) || failure.Category != "ownership" {
		t.Fatalf("owner failure lost: %v", err)
	}
	data.Owners[0].ProjectID = "p"
	m.database = failedMaintenance{data, &store.AttachmentMaintenanceError{Stage: store.AttachmentMaintenanceSnapshotCommit, Cause: cause}}
	_, err = m.snapshot(t.Context())
	if !errors.As(err, &failure) || failure.Category != "database" || !errors.Is(err, cause) {
		t.Fatalf("database failure lost: %v", err)
	}
}

func TestMaintenanceDiagnosticsPreserveSafeMessages(t *testing.T) {
	for _, test := range []struct {
		stage      store.AttachmentMaintenanceStage
		diagnostic string
	}{
		{store.AttachmentMaintenanceConfig, "Migration database configuration is invalid."},
		{store.AttachmentMaintenanceConnect, "Migration database connection failed."},
		{store.AttachmentMaintenanceLock, "Migration ownership lock failed."},
		{store.AttachmentMaintenanceSnapshotOpen, "Migration metadata snapshot could not be opened."},
		{store.AttachmentMaintenanceSnapshotTimezone, "Migration snapshot time zone could not be set."},
		{store.AttachmentMaintenanceIdentityRead, "Migration database identity could not be read."},
		{store.AttachmentMaintenanceRelationsRead, "Migration source tables could not be identified."},
		{store.AttachmentMaintenanceProjectsQuery, "Migration projects could not be read."},
		{store.AttachmentMaintenanceProjectsDecode, "Migration project row could not be decoded."},
		{store.AttachmentMaintenanceProjectsRead, "Migration project inventory failed."},
		{store.AttachmentMaintenanceTasksQuery, "Migration tasks could not be read."},
		{store.AttachmentMaintenanceTasksDecode, "Migration task row could not be decoded."},
		{store.AttachmentMaintenanceTasksRead, "Migration task inventory failed."},
		{store.AttachmentMaintenanceMetadataQuery, "Migration attachment metadata could not be read."},
		{store.AttachmentMaintenanceMetadataDecode, "Migration attachment row could not be decoded."},
		{store.AttachmentMaintenanceMetadataRead, "Migration attachment inventory failed."},
		{store.AttachmentMaintenanceSnapshotCommit, "Migration metadata snapshot could not be closed."},
	} {
		err := &store.AttachmentMaintenanceError{Stage: test.stage, Cause: errors.New("sensitive value")}
		if got := MaintenanceDiagnostic(err); got != test.diagnostic {
			t.Errorf("%s: %q", test.stage, got)
		}
	}
}
