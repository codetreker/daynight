package sessionrelay

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"
)

func markerMigration(t *testing.T) (*archiveLayoutMigration, string) {
	t.Helper()
	root := t.TempDir()
	storage, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := storage.Close(); err != nil {
			t.Error(err)
		}
	})
	return &archiveLayoutMigration{root: storage, phase: "marker", fileSync: (*os.File).Sync}, root
}

func TestArchiveLayoutMarkerRejectsInvalidRecords(t *testing.T) {
	for _, value := range []string{"", "{", "{}", `{"version":2}`, `{"version":1.0}`, `{"version":"1"}`, `{"version":true}`, `{"version":1,"version":1}`, `{"version":1,"extra":true}`, `{"version":1}{}`, `[]`, strings.Repeat(" ", archiveLayoutMarkerLimit+1)} {
		t.Run(value, func(t *testing.T) {
			m, root := markerMigration(t)
			if err := os.WriteFile(filepath.Join(root, SessionArchiveLayoutMarker), []byte(value), 0o600); err != nil {
				t.Fatal(err)
			}
			applied, err := m.readCompletionMarker(context.Background())
			var failure *ArchiveLayoutMigrationError
			if applied || !errors.As(err, &failure) || failure.Category != "invalid_marker" {
				t.Fatal("invalid marker accepted", applied, err)
			}
		})
	}
}

func TestArchiveLayoutMarkerRejectsSymlinksDirectoriesAndUnreadableFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "directory", "unreadable"} {
		t.Run(kind, func(t *testing.T) {
			m, root := markerMigration(t)
			marker := filepath.Join(root, SessionArchiveLayoutMarker)
			var err error
			switch kind {
			case "symlink":
				target := filepath.Join(root, "other.json")
				if err := os.WriteFile(target, []byte(`{"version":1}`), 0o600); err != nil {
					t.Fatal(err)
				}
				err = os.Symlink(target, marker)
			case "directory":
				err = os.Mkdir(marker, 0o700)
			case "unreadable":
				err = os.WriteFile(marker, []byte(`{"version":1}`), 0)
				if os.Geteuid() == 0 {
					t.Skip("root can read permission-denied files")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if applied, err := m.readCompletionMarker(context.Background()); applied || err == nil {
				t.Fatal("unsafe marker accepted", applied, err)
			}
		})
	}
}

func TestArchiveLayoutMarkerPublicationFlushesFileThenRootAndRetriesRootFailure(t *testing.T) {
	m, root := markerMigration(t)
	failure := errors.New("root flush failed")
	flushes := 0
	m.fileSync = func(file *os.File) error {
		flushes++
		if flushes == 1 {
			if !strings.Contains(file.Name(), SessionArchiveLayoutMarker+".tmp-") {
				t.Fatal("marker file was not flushed first")
			}
			return file.Sync()
		}
		return failure
	}
	if err := m.publishCompletionMarker(context.Background()); !errors.Is(err, failure) || flushes != 2 {
		t.Fatal("root flush failure hidden", flushes, err)
	}
	data, err := os.ReadFile(filepath.Join(root, SessionArchiveLayoutMarker))
	if err != nil || !bytes.Equal(data, []byte("{\"version\":1}\n")) {
		t.Fatal("marker rename did not precede root flush", string(data), err)
	}
	if applied, err := m.readCompletionMarker(context.Background()); applied || !errors.Is(err, failure) {
		t.Fatal("unconfirmed root flush was trusted", applied, err)
	}
	if flushes != 3 {
		t.Fatal("startup did not repeat root flush", flushes)
	}
	m.fileSync = (*os.File).Sync
	if applied, err := m.readCompletionMarker(context.Background()); !applied || err != nil {
		t.Fatal("root flush retry did not verify marker", applied, err)
	}
}

func TestArchiveLayoutMarkerFailedAndCanceledPublicationLeavesNoCompletion(t *testing.T) {
	for _, kind := range []string{"file_flush", "canceled", "canceled_after_flush", "rename_conflict", "root_readonly"} {
		t.Run(kind, func(t *testing.T) {
			m, root := markerMigration(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			failure := errors.New("file flush failed")
			switch kind {
			case "file_flush":
				m.fileSync = func(*os.File) error { return failure }
			case "canceled":
				cancel()
			case "canceled_after_flush":
				m.fileSync = func(file *os.File) error { err := file.Sync(); cancel(); return err }
			case "rename_conflict":
				if err := os.Mkdir(filepath.Join(root, SessionArchiveLayoutMarker), 0o700); err != nil {
					t.Fatal(err)
				}
			case "root_readonly":
				if os.Geteuid() == 0 {
					t.Skip("root can write permission-denied directories")
				}
				if err := os.Chmod(root, 0o500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := os.Chmod(root, 0o700); err != nil {
						t.Error(err)
					}
				})
			}
			err := m.publishCompletionMarker(ctx)
			if err == nil {
				t.Fatal("failed marker publication reported success")
			}
			if kind == "file_flush" && !errors.Is(err, failure) {
				t.Fatal("file flush error lost", err)
			}
			if strings.HasPrefix(kind, "canceled") && !errors.Is(err, context.Canceled) {
				t.Fatal("cancellation lost", err)
			}
			entries, err := os.ReadDir(root)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), SessionArchiveLayoutMarker+".tmp-") || entry.Name() == SessionArchiveLayoutMarker && kind != "rename_conflict" {
					t.Fatal("failed publication retained its marker or temporary file", entry.Name())
				}
			}
		})
	}
}

func TestArchiveLayoutMarkerClosedAndCanceledReadFails(t *testing.T) {
	m, _ := markerMigration(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if applied, err := m.readCompletionMarker(ctx); applied || !errors.Is(err, context.Canceled) {
		t.Fatal("canceled marker check succeeded", applied, err)
	}
	if applied, err := m.readCompletionMarker(context.Background()); applied || err != nil {
		t.Fatal("absent marker considered completed", applied, err)
	}
	if err := m.root.Close(); err != nil {
		t.Fatal(err)
	}
	if applied, err := m.readCompletionMarker(context.Background()); applied || err == nil {
		t.Fatal("closed root marker check succeeded", applied, err)
	}
}

func TestArchiveLayoutStartupSkipsInventoriesAfterCompletedMarker(t *testing.T) {
	f, root := archiveLayoutTestFiles(t)
	seed := seedArchiveLayout(t, f, "task", 1, true)
	first, err := migrateArchiveLayout(t, f, root)
	if err != nil || first.AlreadyApplied || first.MovedCount != 1 {
		t.Fatal(first, err)
	}
	objectPath := filepath.Join(root, sessionarchive.Bucket, seed.namespace.Directory(), seed.digest+".json")
	objectBefore, err := os.Stat(objectPath)
	if err != nil {
		t.Fatal(err)
	}
	markerBefore, err := os.Stat(filepath.Join(root, SessionArchiveLayoutMarker))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.DB.Pool.Exec(context.Background(), `DROP TABLE session_archives`); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, sessionarchive.Bucket, "not-a-session"), []byte("unrelated"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := migrateArchiveLayout(t, f, root)
	if err != nil || !second.AlreadyApplied || second.SessionCount != 0 {
		t.Fatal("completed startup queried metadata or storage inventory", second, err)
	}
	objectAfter, err := os.Stat(objectPath)
	if err != nil || !os.SameFile(objectBefore, objectAfter) || !objectBefore.ModTime().Equal(objectAfter.ModTime()) {
		t.Fatal("marker skip replaced or modified archive object", err)
	}
	markerAfter, err := os.Stat(filepath.Join(root, SessionArchiveLayoutMarker))
	if err != nil || !os.SameFile(markerBefore, markerAfter) || !markerBefore.ModTime().Equal(markerAfter.ModTime()) {
		t.Fatal("marker skip rewrote completion marker", err)
	}
	data, err := os.ReadFile(objectPath)
	if err != nil || !bytes.Equal(data, seed.body) {
		t.Fatal("marker skip changed completed bytes", err)
	}
}

func TestArchiveLayoutStartupResumesAfterMetadataCommitBeforeMarkerPublication(t *testing.T) {
	f, root, seed, m, record := archiveLayoutPrepared(t)
	if moved, err := m.apply(context.Background(), record); !moved || err != nil {
		t.Fatal("initial move failed", moved, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.publishCompletionMarker(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled completion published", err)
	}
	if _, err := os.Stat(filepath.Join(root, SessionArchiveLayoutMarker)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("incomplete startup has a marker", err)
	}
	summary, err := migrateArchiveLayout(t, f, root)
	if err != nil || summary.AlreadyApplied || summary.SessionCount != 1 || summary.MovedCount != 0 {
		t.Fatal("completed move could not be resumed", summary, err)
	}
	data, err := os.ReadFile(filepath.Join(root, sessionarchive.Bucket, seed.namespace.Directory(), seed.digest+".json"))
	if err != nil || !bytes.Equal(data, seed.body) {
		t.Fatal("resumed startup changed committed bytes", err)
	}
}
