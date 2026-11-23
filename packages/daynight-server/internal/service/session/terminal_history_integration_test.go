package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Seed the persisted historical record and uploaded bytes directly; the reader
// does not depend on the removed live registration or archive upload operations.
func seedTerminalHistory(t *testing.T, f serviceFixture, files filestorage.Storage) (string, []byte, string) {
	t.Helper()
	ctx := t.Context()
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	id, claim := uuid.NewString(), uuid.NewString()
	owner := v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.registration.WorkerID, WorktreeID: f.registration.WorktreeID, OwnerUserID: f.owner.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}
	doc.SessionID, doc.ClaimID, doc.Owner, doc.FinalizationID = id, claim, owner, uuid.NewString()
	for i := range doc.Runs {
		doc.Runs[i].Owner = owner
	}
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	record := struct {
		Envelope       v2.Envelope
		Owner          v2.Owner
		Runs           []v2.Run
		Recording      map[string]any
		FinalizationID *string
	}{v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, SessionID: id, ClaimID: claim, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, owner, doc.Runs, map[string]any{"1": map[string]any{"Responsibility": v2.RecordingResponsibility{RecordingEnabled: true}, "Evidence": v2.RecordingEvidence{Closed: true, SelectedFrameCount: "1", RegisteredFrameCount: "1", SourceSHA256: digest}}}, &doc.FinalizationID}
	state, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	hash := v2.HashBytes(data)
	ns, err := sessionarchive.NewNamespace(sessionarchive.Projects, f.project, id)
	if err != nil {
		t.Fatal(err)
	}
	path, err := ns.ObjectPath(hash)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.Put(ctx, sessionarchive.Bucket, path, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,backend,snapshot,terminal_state) VALUES($1,$2,$3,$4,$5,$6,'{}','herdr',NULL,$7)`, id, f.project, f.task, claim, f.owner.UserID, uuid.NewString(), state); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness,finalization_id,receipt) VALUES($1,'ready',$2,$3,$4,2,$5,$6,'{"disposition":"ready"}')`, id, hash, len(data), path, doc.Completeness, doc.FinalizationID); err != nil {
		t.Fatal(err)
	}
	return id, data, hash
}

func TestPersistedTerminalHistoryReadAndRevocation(t *testing.T) {
	for _, revoke := range []string{"credential", "project"} {
		t.Run(revoke, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			f := newServiceFixture(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			id, data, hash := seedTerminalHistory(t, f, files)
			cfg := f.db.Pool.Config().Copy()
			cfg.MaxConns = 1
			pool, err := pgxpool.NewWithConfig(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			engine := core.NewEngine(files)
			t.Cleanup(func() { _ = engine.Stop(context.Background()) })
			s := New(&postgres.Store{Pool: pool}, engine)
			page, err := s.TerminalHistory(ctx, f.owner, f.project, f.task, "", 10)
			if err != nil {
				t.Fatal(err)
			}
			items := page["items"].([]map[string]any)
			if len(items) != 1 || items[0]["sessionId"] != id || items[0]["contentKind"] != "terminal_recording" {
				t.Fatalf("history: %#v", page)
			}
			status, err := s.TerminalArchiveStatus(ctx, f.owner, f.project, f.task, id)
			if err != nil {
				t.Fatal(err)
			}
			archive := status.Payload.(v2.ArchiveStatus)
			if archive.State != "ready" || archive.SHA256 == nil || *archive.SHA256 != hash {
				t.Fatalf("status: %+v", archive)
			}
			content, err := s.TerminalArchiveContent(ctx, f.owner, f.project, f.task, id)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(content.Data, data) {
				t.Fatal("archive bytes changed")
			}
			permit, err := files.TryAcquireArchive(ctx, f.owner.UserID, "", 1, true)
			if !errors.Is(err, filestorage.ErrGateBusy) {
				if permit != nil {
					_ = permit.Close()
				}
				t.Fatalf("archive did not retain owner permit: %v", err)
			}
			if revoke == "credential" {
				if _, err = f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.owner.CredentialID); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err = f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
					t.Fatal(err)
				}
				if _, err = projectservice.NewProjects(f.db, engine).Delete(ctx, f.owner, f.project); err != nil {
					t.Fatal(err)
				}
				ns, err := sessionarchive.NewNamespace(sessionarchive.Projects, f.project, id)
				if err != nil {
					t.Fatal(err)
				}
				originalPath, err := ns.ObjectPath(hash)
				if err != nil {
					t.Fatal(err)
				}
				var state, storedHash, storedPath string
				var size int
				if err = f.db.Pool.QueryRow(ctx, `SELECT state,sha256,byte_length,object_path FROM session_archives WHERE session_id=$1`, id).Scan(&state, &storedHash, &size, &storedPath); err != nil {
					t.Fatal(err)
				}
				if state != "ready" || storedHash != hash || size != len(data) || storedPath != originalPath {
					t.Fatalf("archive manifest changed after deletion: %s %s %d %s", state, storedHash, size, storedPath)
				}
				object, err := files.Open(ctx, sessionarchive.Bucket, originalPath)
				if err != nil {
					t.Fatal(err)
				}
				stored, readErr := io.ReadAll(object.Body)
				closeErr := object.Body.Close()
				if readErr != nil || closeErr != nil || !bytes.Equal(stored, data) {
					t.Fatalf("archive object changed after deletion: %v %v", readErr, closeErr)
				}
			}
			if !bytes.Equal(content.Data, data) {
				t.Fatal("retained bytes changed after revocation")
			}
			if err = content.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err = s.TerminalArchiveContent(ctx, f.owner, f.project, f.task, id); err == nil {
				t.Fatal("revoked archive remained readable")
			}
			if _, err = s.TerminalHistory(ctx, f.owner, f.project, f.task, "", 10); err == nil {
				t.Fatal("revoked history remained readable")
			}
			if _, err = s.TerminalArchiveStatus(ctx, f.owner, f.project, f.task, id); err == nil {
				t.Fatal("revoked archive status remained readable")
			}
		})
	}
}

func TestParentDeletionHidesPersistedTerminalHistory(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	f := newServiceFixture(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	engine := core.NewEngine(files)
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	s := New(f.db, engine)
	goal := uuid.NewString()
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status,type) VALUES($1,$2,'parent','in_progress','goal')`, goal, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, f.task); err != nil {
		t.Fatal(err)
	}
	id, _, _ := seedTerminalHistory(t, f, files)
	if _, err = f.db.Pool.Exec(ctx, `WITH deleted AS (UPDATE tasks SET deleted_at=now() WHERE id=$1 RETURNING deleted_at)
		UPDATE tasks SET ancestor_deleted_at=deleted.deleted_at FROM deleted WHERE parent_id=$1`, goal); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TerminalHistory(ctx, f.owner, f.project, f.task, "", 10); err == nil {
		t.Fatal("hidden task history was readable")
	}
	if _, err = s.TerminalArchiveContent(ctx, f.owner, f.project, f.task, id); err == nil {
		t.Fatal("hidden task content was readable")
	}
	status, err := s.TerminalArchiveStatus(ctx, f.owner, f.project, f.task, id)
	if err != nil || status.Payload.(v2.ArchiveStatus).State != "ready" {
		t.Fatalf("owner status: %+v %v", status, err)
	}
}
