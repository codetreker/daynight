package session

import (
	"bytes"
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func botArchiveDeletionFixture(t *testing.T) (fixture, BotRegistrationResult, []byte, string, botservice.BotDeletionReceipt) {
	t.Helper()
	f, out, _ := registeredBot(t)
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	f.s.files = files
	v := out.Session
	// A terminated native execution may already be archived when its owner
	// requests deletion. The ordinary Test stop API deliberately excludes Bots.
	if _, err = f.db.Pool.Exec(context.Background(), `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"') WHERE id=$1`, v.SessionID); err != nil {
		t.Fatal(err)
	}
	doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, Entries: []sp.TimelineEntry{localEntry(t, "1")}, Resources: []sp.ArchiveResource{}}
	receipt := botservice.BotDeletionReceipt{DeletionID: uuid.NewString(), Result: model.BotCleanupResult{State: "completed"}, Stop: &sp.TestStop{Protocol: sp.Protocol, Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
	return f, out, encode(doc), root, receipt
}

func TestBotDeletionWaitsForAdmittedArchiveAndRemovesItsNamespace(t *testing.T) {
	f, out, data, root, receipt := botArchiveDeletionFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	files := f.s.files
	// This file models a successful object write whose metadata transaction
	// never committed; cleanup must enumerate the Session namespace itself.
	orphan := testArchiveDirectory(t, "", f.p.UserID, out.Session.SessionID) + "/orphan.json"
	if _, err := files.Put(ctx, archiveBucket, orphan, bytes.NewBufferString("orphan")); err != nil {
		t.Fatal(err)
	}
	unrelated := testArchiveDirectory(t, f.project, f.p.UserID, uuid.NewString()) + "/task.json"
	if _, err := files.Put(ctx, archiveBucket, unrelated, bytes.NewBufferString("task archive")); err != nil {
		t.Fatal(err)
	}
	gate := &blockingArchiveStorage{Storage: files, entered: make(chan struct{}), release: make(chan struct{})}
	f.s.files = gate
	upload := make(chan error, 1)
	go func() {
		_, err := f.s.PutArchive(ctx, f.p, "", "", out.Session.SessionID, data)
		upload <- err
	}()
	select {
	case <-gate.entered:
	case err := <-upload:
		t.Fatalf("upload did not reach storage barrier: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	other := botservice.NewDeletions(f.db, files, NewEngine(files))
	deletion := make(chan error, 1)
	go func() {
		_, err := other.DeleteBot(ctx, f.p, out.Bot.ID, store.DeleteBot{Version: out.Bot.Version, DeletionID: receipt.DeletionID})
		deletion <- err
	}()
	waitErr := waitBotArchiveLock(ctx, f)
	close(gate.release)
	uploadErr, deletionErr := <-upload, <-deletion
	if waitErr != nil || uploadErr != nil || deletionErr != nil {
		t.Fatalf("archive-first ordering failed: wait=%v upload=%v delete=%v", waitErr, uploadErr, deletionErr)
	}
	var state string
	if err := f.db.Pool.QueryRow(ctx, `SELECT state FROM session_archives WHERE session_id=$1`, out.Session.SessionID).Scan(&state); err != nil || state != "ready" {
		t.Fatalf("admitted upload did not commit before deletion: %s %v", state, err)
	}
	done, err := other.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil || done.Deletion == nil || done.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("cleanup did not complete: %+v %v", done, err)
	}
	if _, err = os.Stat(filepath.Join(root, archiveBucket, testArchiveDirectory(t, "", f.p.UserID, out.Session.SessionID))); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("admitted upload or orphan namespace remains: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(root, archiveBucket, unrelated)); err != nil || string(data) != "task archive" {
		t.Fatalf("unrelated archive changed: %q %v", data, err)
	}
	if _, err = f.s.PutArchive(ctx, f.p, "", "", out.Session.SessionID, data); err == nil {
		t.Fatal("late retry rewrote the cleaned namespace")
	}
}

type blockingBotCleanupStorage struct {
	filestorage.Storage
	entered chan struct{}
	release chan struct{}
}

func (s *blockingBotCleanupStorage) DeleteSessionArchives(ctx context.Context, namespace sessionarchive.Namespace) error {
	close(s.entered)
	select {
	case <-s.release:
		return s.Storage.DeleteSessionArchives(ctx, namespace)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestBotDeletionPrecedesArchiveAndCleanupCannotBeFollowedByLateUpload(t *testing.T) {
	f, out, data, root, receipt := botArchiveDeletionFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	gate := &blockingBotCleanupStorage{Storage: f.s.files, entered: make(chan struct{}), release: make(chan struct{})}
	other := botservice.NewDeletions(f.db, gate, NewEngine(gate))
	request := store.DeleteBot{Version: out.Bot.Version, DeletionID: receipt.DeletionID}
	if _, err := other.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	_, err := f.s.PutArchive(ctx, f.p, "", "", out.Session.SessionID, data)
	botFault(t, err, "resource_conflict")
	cleanup := make(chan error, 1)
	go func() {
		result, err := other.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
		if err == nil && (result.Deletion == nil || result.Deletion.ServerCleanup.State != "completed") {
			err = errors.New("cleanup did not report completed")
		}
		cleanup <- err
	}()
	select {
	case <-gate.entered:
	case err := <-cleanup:
		t.Fatalf("cleanup did not reach storage barrier: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	upload := make(chan error, 1)
	go func() {
		_, err := f.s.PutArchive(ctx, f.p, "", "", out.Session.SessionID, data)
		upload <- err
	}()
	waitCtx, stopWait := context.WithCancel(ctx)
	wait := make(chan error, 1)
	go func() { wait <- waitBotArchiveLock(waitCtx, f) }()
	var uploadErr error
	var uploadFinished bool
	select {
	case uploadErr = <-upload:
		uploadFinished = true
	case waitErr := <-wait:
		if waitErr != nil {
			t.Error(waitErr)
		}
	case <-ctx.Done():
		t.Error(ctx.Err())
	}
	stopWait()
	close(gate.release)
	cleanupErr := <-cleanup
	if !uploadFinished {
		uploadErr = <-upload
	}
	if cleanupErr != nil || uploadErr == nil {
		t.Fatalf("delete-first ordering failed: cleanup=%v upload=%v", cleanupErr, uploadErr)
	}
	botFault(t, uploadErr, "resource_conflict")
	if _, err = os.Stat(filepath.Join(root, archiveBucket, testArchiveDirectory(t, "", f.p.UserID, out.Session.SessionID))); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("late upload recreated deleted namespace: %v", err)
	}
	var records int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archives WHERE session_id=$1`, out.Session.SessionID).Scan(&records); err != nil || records != 0 {
		t.Fatalf("late upload recreated metadata: %d %v", records, err)
	}
}

// Scope the waiter to this fixture's table OID; concurrent package test runs
// against the same database may hold unrelated Bot locks in another schema.
func waitBotArchiveLock(ctx context.Context, f fixture) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := f.db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND a.query LIKE 'SELECT id::text FROM bots WHERE id=%' AND l.relation='bots'::regclass)`).Scan(&waiting); err != nil {
			return err
		}
		if waiting {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
