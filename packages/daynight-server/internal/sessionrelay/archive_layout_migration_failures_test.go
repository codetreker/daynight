package sessionrelay

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestArchiveLayoutMigrationRejectsDamagedDatabaseOwnershipAndManifests(t *testing.T) {
	for _, damage := range []string{"orphan_manifest", "task_without_project", "independent_with_project", "unknown_scope", "zero_project", "incomplete_manifest", "wrong_version", "undecodable_scope"} {
		t.Run(damage, func(t *testing.T) {
			f, root := archiveLayoutTestFiles(t)
			seed := seedArchiveLayout(t, f, "task", 1, true)
			ctx := context.Background()
			var err error
			switch damage {
			case "orphan_manifest":
				_, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM task_sessions WHERE id=$1`, seed.id)
			case "task_without_project", "independent_with_project", "unknown_scope", "undecodable_scope":
				_, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE task_sessions DROP CONSTRAINT session_scope_binding`)
				if err != nil {
					t.Fatal(err)
				}
				switch damage {
				case "task_without_project":
					_, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET project_id=NULL WHERE id=$1`, seed.id)
				case "independent_with_project":
					_, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET scope='test' WHERE id=$1`, seed.id)
				case "unknown_scope":
					_, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET scope='invalid' WHERE id=$1`, seed.id)
				case "undecodable_scope":
					_, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE task_sessions ALTER COLUMN scope DROP NOT NULL; UPDATE task_sessions SET scope=NULL`)
				}
			case "zero_project":
				_, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET project_id=$2 WHERE id=$1`, seed.id, uuid.Nil.String())
			case "incomplete_manifest":
				_, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE session_archives DROP CONSTRAINT session_archive_body; UPDATE session_archives SET byte_length=NULL`)
			case "wrong_version":
				_, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE session_archives DROP CONSTRAINT session_archive_version; UPDATE session_archives SET schema_version=2`)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = migrateArchiveLayout(t, f, root); err == nil {
				t.Fatal("damaged archive ownership or manifest accepted")
			}
			if _, err = os.Stat(filepath.Join(root, sessionarchive.Bucket, seed.id)); err != nil {
				t.Fatal("damaged metadata moved original namespace", err)
			}
		})
	}
}

func archiveLayoutPrepared(t *testing.T) (fixture, string, archiveLayoutSeed, *archiveLayoutMigration, *archiveLayoutRecord) {
	t.Helper()
	f, root := archiveLayoutTestFiles(t)
	seed := seedArchiveLayout(t, f, "task", 1, true)
	ctx := context.Background()
	connection, err := pgx.ConnectConfig(ctx, f.s.DB.Pool.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := connection.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	storage, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := storage.Close(); err != nil {
			t.Error(err)
		}
	})
	m := &archiveLayoutMigration{database: connection, root: storage, phase: "inventory"}
	records, err := m.snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = m.preflight(ctx, records); err != nil {
		t.Fatal(err)
	}
	for _, r := range records {
		if r.id == seed.id {
			return f, root, seed, m, r
		}
	}
	t.Fatal("seeded migration record missing")
	return fixture{}, "", archiveLayoutSeed{}, nil, nil
}

func TestArchiveLayoutMigrationRejectsChangedResourcesBeforeMove(t *testing.T) {
	for _, change := range []string{"session_deleted", "manifest_table_removed", "source_removed", "destination_created", "parent_replaced", "rename_permission"} {
		t.Run(change, func(t *testing.T) {
			f, root, seed, m, record := archiveLayoutPrepared(t)
			ctx := context.Background()
			var err error
			switch change {
			case "session_deleted":
				_, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM task_sessions WHERE id=$1`, seed.id)
			case "manifest_table_removed":
				_, err = f.s.DB.Pool.Exec(ctx, `DROP TABLE session_archives`)
			case "source_removed":
				err = os.RemoveAll(filepath.Join(root, sessionarchive.Bucket, seed.id))
			case "destination_created":
				err = os.MkdirAll(filepath.Join(root, sessionarchive.Bucket, seed.namespace.Directory()), 0o700)
			case "parent_replaced":
				err = os.WriteFile(filepath.Join(root, sessionarchive.Bucket, "projects"), []byte("conflict"), 0o600)
			case "rename_permission":
				parent := filepath.Dir(filepath.Join(root, sessionarchive.Bucket, seed.namespace.Directory()))
				err = os.MkdirAll(parent, 0o700)
				if err != nil {
					t.Fatal(err)
				}
				err = os.Chmod(parent, 0o500)
				t.Cleanup(func() {
					if err := os.Chmod(parent, 0o700); err != nil {
						t.Error(err)
					}
				})
				if os.Geteuid() == 0 {
					t.Skip("directory write permissions do not restrict root")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = m.apply(ctx, record); err == nil {
				t.Fatal("changed resource was accepted")
			}
		})
	}
}

func TestArchiveLayoutMigrationCanceledAndClosedResourceErrorsRemainVisible(t *testing.T) {
	f, root, _, m, record := archiveLayoutPrepared(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.readDirectory(ctx, "."); !errors.Is(err, context.Canceled) {
		t.Fatal("directory cancellation lost", err)
	}
	if err := m.makeParents(ctx, sessionarchive.Bucket+"/new/path"); !errors.Is(err, context.Canceled) {
		t.Fatal("parent cancellation lost", err)
	}
	if _, err := io.ReadAll(archiveLayoutReader{ctx, strings.NewReader("content")}); !errors.Is(err, context.Canceled) {
		t.Fatal("stream cancellation lost", err)
	}
	if err := os.WriteFile(filepath.Join(root, "regular-file"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.readDirectory(context.Background(), "regular-file"); err == nil {
		t.Fatal("regular file listed as a directory")
	}
	if _, err := m.readDirectory(context.Background(), "missing"); err == nil {
		t.Fatal("missing directory listed")
	}
	if err := m.syncDirectory("missing"); err == nil {
		t.Fatal("missing directory synchronized")
	}
	if err := m.syncParents("missing"); err == nil {
		t.Fatal("missing parent chain synchronized")
	}
	if err := os.WriteFile(filepath.Join(root, "bad\nfilename"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.inventory(context.Background(), "."); err == nil {
		t.Fatal("invalid storage filename inventoried")
	}
	if err := m.database.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.snapshot(context.Background()); err == nil {
		t.Fatal("closed database snapshot succeeded")
	}
	if _, err := m.apply(context.Background(), record); err == nil {
		t.Fatal("closed database update succeeded")
	}
	if err := m.root.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.directoryExists("."); err == nil {
		t.Fatal("closed root inspected successfully")
	}
	if err := m.makeParents(context.Background(), "new/path"); err == nil {
		t.Fatal("closed root accepted parent creation")
	}
	if err := m.syncDirectory("."); err == nil {
		t.Fatal("closed root synchronized")
	}
	if _, err := MigrateSessionArchiveLayout(context.Background(), f.s.DB.Pool.Config().ConnConfig.ConnString(), "", nil); err == nil {
		t.Fatal("missing storage configuration accepted")
	}
}
