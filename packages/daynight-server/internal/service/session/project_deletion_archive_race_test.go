package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

type heldDeletion struct {
	*postgres.Store
	entered, release chan struct{}
}

func (d *heldDeletion) WriteProjectDeletion(ctx context.Context, id string, work func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return d.Store.WriteProjectDeletion(ctx, id, func(scope store.ProjectDeletionScope) error {
		close(d.entered)
		select {
		case <-d.release:
			return work(scope)
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

func waitArchiveLock(ctx context.Context, db *postgres.Store, query string) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var count int
		err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`, "%"+query+"%").Scan(&count)
		if err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func readyTerminalArchive(t *testing.T, f serviceFixture) (string, []byte) {
	return readyTerminalArchiveWithDeletion(t, f, nil, nil, "")
}

func readyTerminalArchiveWithDeletion(t *testing.T, f serviceFixture, afterStart func(string), writer *completionWriter, completion string) (string, []byte) {
	t.Helper()
	ctx := t.Context()
	f.service.SetOrigin("https://daynight.example")
	if _, err := f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{agentControlMode}','"herdr"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	pane := "pane"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: f.registration.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.registration.WorkerID, WorktreeID: f.registration.WorktreeID, OwnerUserID: f.owner.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}, Binding: v2.Binding{InstanceID: "instance", SessionID: "herdr", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_one"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	reg := m.Payload.(v2.Registration)
	reg.Binding = doc.Runs[0].Binding
	m.Payload = reg
	doc.SessionID = m.SessionID
	doc.ClaimID = m.ClaimID
	doc.Owner = reg.Owner
	doc.FinalizationID = uuid.NewString()
	for i := range doc.Runs {
		doc.Runs[i].Owner = reg.Owner
	}
	if _, err = f.service.RegisterTerminal(ctx, f.owner, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	active := doc.Runs[0]
	active.StopProof = nil
	active.StoppedAt = nil
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{active}}
	if _, err = f.service.UpdateTerminalLedger(ctx, f.owner, f.project, f.task, m.SessionID, "1", ledger); err != nil {
		t.Fatal(err)
	}
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	if _, err = f.service.UpdateTerminalRecording(ctx, f.owner, f.project, f.task, m.SessionID, "1", responsibility); err != nil {
		t.Fatal(err)
	}
	ledger.Payload = v2.GenerationLedger{Runs: doc.Runs}
	if afterStart != nil {
		afterStart(m.SessionID)
		writer.inject(completion, nil)
		if _, err = f.service.UpdateTerminalLedger(ctx, f.owner, f.project, f.task, m.SessionID, "1", ledger); !errors.Is(err, errInjectedCompletion) {
			t.Fatalf("unknown stopped ledger outcome lost: %v", err)
		}
	}
	if _, err = f.service.UpdateTerminalLedger(ctx, f.owner, f.project, f.task, m.SessionID, "1", ledger); err != nil {
		t.Fatal(err)
	}
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	evidence := m
	evidence.Type = "recording_evidence"
	evidence.Payload = v2.RecordingEvidence{ResponsibilityID: responsibility.Payload.(v2.RecordingResponsibility).ResponsibilityID, EvidenceID: uuid.NewString(), Revision: "1", SelectedFrameCount: "1", RegisteredFrameCount: "1", Closed: true, JournalSHA256: v2.HashBytes([]byte("durable journal")), SourceSHA256: digest}
	if _, err = f.service.UpdateTerminalRecording(ctx, f.owner, f.project, f.task, m.SessionID, "1", evidence); err != nil {
		t.Fatal(err)
	}
	if afterStart == nil {
		if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
			t.Fatal(err)
		}
	}
	final := m
	final.Type = "finalization"
	final.Payload = v2.Finalization{FinalizationID: doc.FinalizationID, ClaimTerminal: true, Runs: doc.Runs}
	if _, err = f.service.FinalizeTerminal(ctx, f.owner, f.project, f.task, m.SessionID, "1", final); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return m.SessionID, out
}

func TestProjectDeletionSerializesWithSessionArchives(t *testing.T) {
	for _, backend := range []string{"web", "terminal"} {
		for _, order := range []string{"archive-first", "delete-first"} {
			t.Run(backend+"/"+order, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
				defer cancel()
				f := newServiceFixture(t)
				files, err := local.New(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = files.Close() })
				uploadGate := &serviceStorageBarrier{Storage: files, kind: "upload", manifestOnly: true, entered: make(chan struct{}), release: make(chan struct{})}
				var once sync.Once
				releaseUpload := func() { once.Do(func() { close(uploadGate.release) }) }
				t.Cleanup(releaseUpload)
				engine := core.NewEngine(uploadGate)
				defer engine.Stop(context.Background())
				f.service = New(f.db, engine)
				var id string
				var data []byte
				if backend == "web" {
					v := f.registerWeb(t)
					id = v.SessionID
					if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
						t.Fatal(err)
					}
					data = prepareServiceArchive(t, ctx, f.service, f.owner, f.project, f.task, v)
				} else {
					id, data = readyTerminalArchive(t, f)
				}
				if _, err = f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
					t.Fatal(err)
				}
				if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, f.task); err != nil {
					t.Fatal(err)
				}
				deletionGate := &heldDeletion{Store: f.db, entered: make(chan struct{}), release: make(chan struct{})}
				var dOnce sync.Once
				releaseDelete := func() { dOnce.Do(func() { close(deletionGate.release) }) }
				t.Cleanup(releaseDelete)
				deletions := projectservice.NewProjects(deletionGate, engine)
				archive := make(chan error, 1)
				deletion := make(chan error, 1)
				upload := func() {
					if backend == "web" {
						err := publishServiceArchive(ctx, f.service, f.owner, f.project, f.task, id, data)
						archive <- err
					} else {
						_, err := f.service.PutTerminalArchive(ctx, f.owner, f.project, f.task, id, data)
						archive <- err
					}
				}
				remove := func() {
					receipt, err := deletions.Delete(ctx, f.owner, f.project)
					if err == nil && (!receipt.Deleted || receipt.ProjectID != f.project) {
						err = fmt.Errorf("invalid receipt %+v", receipt)
					}
					deletion <- err
				}
				if order == "archive-first" {
					go upload()
					awaitBarrier(t, ctx, uploadGate, archive)
					go remove()
					if backend == "web" {
						// Publication performs volume I/O without holding the Task row.
						// Deletion can commit first; the late manifest must not become ready.
						select {
						case <-deletionGate.entered:
						case err = <-deletion:
							t.Fatalf("deletion did not acquire locks: %v", err)
						case <-ctx.Done():
							t.Fatal(ctx.Err())
						}
						releaseDelete()
						if err = <-deletion; err != nil {
							t.Fatal(err)
						}
						releaseUpload()
						requireServiceError(t, <-archive, "not_found")
						var ready int
						if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archives WHERE session_id=$1 AND state='ready'`, id).Scan(&ready); err != nil || ready != 0 {
							t.Fatalf("late archive became ready: %d %v", ready, err)
						}
					} else {
						if err = waitArchiveLock(ctx, f.db, "SELECT id FROM tasks WHERE project_id=$1 ORDER BY id FOR UPDATE"); err != nil {
							t.Fatal(err)
						}
						releaseUpload()
						if err = <-archive; err != nil {
							t.Fatal(err)
						}
						select {
						case <-deletionGate.entered:
						case err = <-deletion:
							t.Fatalf("deletion did not acquire locks: %v", err)
						case <-ctx.Done():
							t.Fatal(ctx.Err())
						}
						releaseDelete()
						if err = <-deletion; err != nil {
							t.Fatal(err)
						}
						var state, path string
						if err = f.db.Pool.QueryRow(ctx, `SELECT state,object_path FROM session_archives WHERE session_id=$1`, id).Scan(&state, &path); err != nil || state != "ready" {
							t.Fatalf("archive lost: %s %v", state, err)
						}
						object, err := files.Open(ctx, sessionarchive.Bucket, path)
						if err != nil {
							t.Fatal(err)
						}
						retained, err := io.ReadAll(object.Body)
						closeErr := object.Body.Close()
						if err != nil || closeErr != nil || !bytes.Equal(retained, data) {
							t.Fatalf("archive bytes changed: %v %v", err, closeErr)
						}
					}
				} else {
					go remove()
					select {
					case <-deletionGate.entered:
					case err = <-deletion:
						t.Fatalf("deletion did not acquire locks: %v", err)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					go upload()
					if err = waitArchiveLock(ctx, f.db, "SELECT id::text FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE"); err != nil {
						t.Fatal(err)
					}
					releaseDelete()
					if err = <-deletion; err != nil {
						t.Fatal(err)
					}
					requireServiceError(t, <-archive, "not_found")
					select {
					case <-uploadGate.entered:
						t.Fatal("deleted project changed archive file")
					default:
					}
				}
				upload()
				requireServiceError(t, <-archive, "not_found")
				if ctx.Err() != nil {
					t.Fatal(ctx.Err())
				}
			})
		}
	}
}
