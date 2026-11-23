package bot_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"reflect"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sessionpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
)

type recoveryArchiveFailure struct {
	*local.Storage
	beforeDelete func(context.Context, sessionarchive.Namespace) error
}

func (s recoveryArchiveFailure) DeleteSessionArchives(ctx context.Context, namespace sessionarchive.Namespace) error {
	if err := s.beforeDelete(ctx, namespace); err != nil {
		return err
	}
	return s.Storage.DeleteSessionArchives(ctx, namespace)
}

type recoveryDiscardedSessions struct{ ids []string }

func (s *recoveryDiscardedSessions) DiscardBotSession(id string) { s.ids = append(s.ids, id) }

func TestBotDeletionRecoveryRetriesRealArchiveAndSQLCleanup(t *testing.T) {
	database := openFixtureStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	f := newFixtureInStore(t, database)
	bot := f.ready(t, f.candidate)
	session, execution := *bot.SessionID, *bot.TestExecutionID
	binding := &model.BotDeletionBinding{SessionID: session, TestExecutionID: execution, ExecutionGeneration: "2", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	metadata := map[string]any{"sessionId": session, "testExecutionId": execution, "executionGeneration": binding.ExecutionGeneration, "identity": map[string]any{"ownerUserId": bot.OwnerUserID, "controllerId": binding.ControllerID, "controllerInstanceId": binding.ControllerInstanceID}}
	raw, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, f.tx, `UPDATE task_sessions SET snapshot=$2 WHERE id=$1`, session, raw)
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, bot.OwnerUserID, session)
	if err != nil {
		t.Fatal(err)
	}
	archivePath, chunkPath, orphanPath := namespace.Directory()+"/history.json", namespace.Directory()+"/chunk", namespace.Directory()+"/orphan/chunk"
	if err = sessionpg.New(f.tx).SetSessionArchiveReady(ctx, session, strings.Repeat("a", 64), 7, archivePath); err != nil {
		t.Fatal(err)
	}
	fileID := uuid.NewString()
	exec(t, f.tx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path) VALUES($1,$2,'history',repeat('a',64),7,7,'complete',$3)`, session, fileID, archivePath)
	exec(t, f.tx, `INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,7,repeat('a',64),$3)`, session, fileID, chunkPath)
	exec(t, f.tx, `INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{}')`, session)
	exec(t, f.tx, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,'{}')`, session, uuid.NewString())
	missing := botcore.MissingExecutionEvidence
	deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: bot.Version, WorkerCleanup: model.BotCleanupResult{State: "failed", Code: &missing}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	bot, err = f.writer.SaveBotDeletion(ctx, bot.ID, deletion)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	otherNamespace, err := sessionarchive.NewNamespace(sessionarchive.Users, bot.OwnerUserID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	otherPath := otherNamespace.Directory() + "/retained.json"
	for _, path := range []string{archivePath, chunkPath, orphanPath, otherPath} {
		if _, err := files.Put(ctx, sessionarchive.Bucket, path, strings.NewReader("private")); err != nil {
			t.Fatal(err)
		}
	}
	assertObject := func(path string, present bool) {
		t.Helper()
		object, err := files.Open(ctx, sessionarchive.Bucket, path)
		if err != nil {
			if !present && errors.Is(err, fs.ErrNotExist) {
				return
			}
			t.Fatalf("archive %q: %v", path, err)
		}
		body, readErr := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if !present || readErr != nil || closeErr != nil || string(body) != "private" {
			t.Fatalf("archive %q present=%t body=%q read=%v close=%v", path, present, body, readErr, closeErr)
		}
	}
	assertRows := func(want int) {
		t.Helper()
		for _, table := range []string{"task_sessions", "session_archives", "session_archive_files", "session_archive_chunks", "session_events", "session_resources"} {
			column := "session_id"
			if table == "task_sessions" {
				column = "id"
			}
			var count int
			if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+column+`=$1`, session).Scan(&count); err != nil || count != want {
				t.Fatalf("%s rows=%d want=%d: %v", table, count, want, err)
			}
		}
	}
	reader := botservice.New(database)
	readRecovery := func() botcore.DeletionRecovery {
		t.Helper()
		result, err := reader.DeletionRecovery(ctx, f.principal, bot.ID)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	input := botcore.ResolveDeletion{Action: "accept_unverified", Version: bot.Version, DeletionID: deletion.DeletionID, OperationID: uuid.NewString(), AcknowledgeLocalUnverified: true, Reason: "The original local execution evidence is unavailable."}
	attempts, expectedVersion := 0, bot.Version+1
	storage := recoveryArchiveFailure{Storage: files, beforeDelete: func(_ context.Context, actual sessionarchive.Namespace) error {
		attempts++
		if actual != namespace {
			t.Fatalf("cleanup namespace: %+v", actual)
		}
		// This independent read must see the committed decision before file I/O.
		committed := readRecovery()
		if committed.Decision == nil || committed.Decision.OperationID != input.OperationID || committed.Version != expectedVersion || committed.ServerCleanup.State != "pending" || !reflect.DeepEqual(committed.OriginalBinding, binding) {
			t.Fatalf("decision before archive removal: %+v", committed)
		}
		assertRows(1)
		if attempts == 1 {
			return errors.New("injected archive deletion failure")
		}
		return nil
	}}
	live := &recoveryDiscardedSessions{}
	service := botservice.NewDeletions(database, storage, live)
	failed, err := service.ResolveDeletion(ctx, f.principal, bot.ID, input)
	if err != nil || failed.ServerCleanup.State != "failed" || failed.ServerCleanup.Code == nil || *failed.ServerCleanup.Code != "server_cleanup_failed" || failed.WorkerCleanup.State != "failed" || failed.Decision == nil || attempts != 1 || len(live.ids) != 0 {
		t.Fatalf("failed cleanup: %+v attempts=%d discarded=%v error=%v", failed, attempts, live.ids, err)
	}
	if stored := readRecovery(); !reflect.DeepEqual(stored, failed) {
		t.Fatalf("failure readback: %+v want %+v", stored, failed)
	}
	assertRows(1)
	assertObject(archivePath, true)
	assertObject(chunkPath, true)
	assertObject(orphanPath, true)
	replayed, err := service.ResolveDeletion(ctx, f.principal, bot.ID, input)
	if err != nil || !reflect.DeepEqual(replayed, failed) || attempts != 1 {
		t.Fatalf("accept replay retried cleanup: %+v attempts=%d error=%v", replayed, attempts, err)
	}
	expectedVersion = failed.Version + 1
	retry := botcore.ResolveDeletion{Action: "retry_cleanup", Version: failed.Version, DeletionID: input.DeletionID, OperationID: input.OperationID}
	completed, err := service.ResolveDeletion(ctx, f.principal, bot.ID, retry)
	if err != nil || completed.ServerCleanup.State != "completed" || attempts != 2 || !reflect.DeepEqual(live.ids, []string{session}) {
		t.Fatalf("retry result: %+v attempts=%d discarded=%v error=%v", completed, attempts, live.ids, err)
	}
	if stored := readRecovery(); !reflect.DeepEqual(stored, completed) || !reflect.DeepEqual(stored.Decision, failed.Decision) || !reflect.DeepEqual(stored.OriginalBinding, binding) || !stored.RequiresStopProof || stored.WorkerCleanup.State != "failed" || stored.WorkerCleanup.Code == nil || *stored.WorkerCleanup.Code != missing {
		t.Fatalf("completed decision readback: %+v", stored)
	}
	assertRows(0)
	assertObject(archivePath, false)
	assertObject(chunkPath, false)
	assertObject(orphanPath, false)
	assertObject(otherPath, true)
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		stored, err := scope.BotDAO().Bot(ctx, bot.ID)
		if err != nil {
			return err
		}
		if stored.SessionID != nil || stored.TestExecutionID != nil || stored.Name != "Deleted" || stored.Deletion.ReceiptDigest != "" {
			t.Fatalf("cleanup tombstone: %+v", stored)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBotDeletionRecoveryBindingAndCommittedRedaction(t *testing.T) {
	database := openFixtureStore(t)
	f := newFixtureInStore(t, database)
	bot := f.ready(t, f.candidate)
	reader := f.reader.(store.BotDeletionBindingReader)
	if _, err := reader.BotDeletionBinding(t.Context(), bot.OwnerUserID, bot.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("active binding: %v", err)
	}
	controller, instance := uuid.NewString(), uuid.NewString()
	metadata := map[string]any{"sessionId": *bot.SessionID, "testExecutionId": *bot.TestExecutionID, "executionGeneration": "2", "identity": map[string]any{"ownerUserId": bot.OwnerUserID, "controllerId": controller, "controllerInstanceId": instance}, "activity": "private", "historyEpoch": "private"}
	raw, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, f.tx, `UPDATE task_sessions SET snapshot=$2 WHERE id=$1`, *bot.SessionID, raw)
	code := "execution_evidence_missing"
	deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: bot.Version, WorkerCleanup: model.BotCleanupResult{State: "failed", Code: &code}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	bot, err = f.writer.SaveBotDeletion(t.Context(), bot.ID, deletion)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := reader.BotDeletionBinding(t.Context(), bot.OwnerUserID, bot.ID)
	if err != nil || snapshot.SessionID != *bot.SessionID || snapshot.TestExecutionID != *bot.TestExecutionID || snapshot.Identity.ControllerID != controller || snapshot.Identity.ControllerInstanceID != instance || snapshot.ExecutionGeneration != "2" || snapshot.Activity != "" || snapshot.HistoryEpoch != "" {
		t.Fatalf("binding: %+v %v", snapshot, err)
	}
	if _, err = reader.BotDeletionBinding(t.Context(), uuid.NewString(), bot.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("owner: %v", err)
	}
	deletion.Recovery = &model.BotDeletionRecovery{WorkerID: bot.WorkerID, OriginalBinding: &model.BotDeletionBinding{SessionID: *bot.SessionID, TestExecutionID: *bot.TestExecutionID, ExecutionGeneration: "2", ControllerID: controller, ControllerInstanceID: instance}, Decision: model.BotDeletionDecision{OperationID: uuid.NewString(), RequestedVersion: bot.Version, ActorUserID: bot.OwnerUserID, Reason: "Original local storage is unavailable.", AcknowledgedAt: time.Date(2026, 11, 23, 1, 2, 3, 0, time.UTC), LocalDisposition: "unverified"}}
	sessions := sessionpg.New(f.tx)
	if err = sessions.DeleteBotSession(t.Context(), *bot.SessionID, bot.ID); err != nil {
		t.Fatal(err)
	}
	if err = sessions.RedactDeletedBot(t.Context(), bot.ID); err != nil {
		t.Fatal(err)
	}
	deletion.ServerCleanup = model.BotCleanupResult{State: "completed"}
	if _, err = f.writer.SaveBotDeletion(t.Context(), bot.ID, deletion); err != nil {
		t.Fatal(err)
	}
	if err = f.tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err = database.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
		stored, err := scope.BotDAO().Bot(t.Context(), bot.ID)
		if err != nil {
			return err
		}
		if stored.SessionID != nil || stored.TestExecutionID != nil || !reflect.DeepEqual(stored.Deletion, deletion) || stored.Deletion.WorkerCleanup.State != "failed" || stored.Deletion.ReceiptDigest != "" {
			t.Fatalf("committed tombstone: %+v", stored)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBotDeletionRecoveryBindingReadFailures(t *testing.T) {
	f := newFixture(t)
	bot := f.ready(t, f.candidate)
	d := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: bot.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	if _, err := f.writer.SaveBotDeletion(t.Context(), bot.ID, d); err != nil {
		t.Fatal(err)
	}
	exec(t, f.tx, `UPDATE task_sessions SET snapshot='{"sessionId":17}' WHERE id=$1`, *bot.SessionID)
	reader := f.reader.(store.BotDeletionBindingReader)
	if _, err := reader.BotDeletionBinding(t.Context(), bot.OwnerUserID, bot.ID); err == nil {
		t.Fatal("invalid stored binding decoded")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := reader.BotDeletionBinding(ctx, bot.OwnerUserID, bot.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
