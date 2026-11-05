package sessionrelay

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func TestBotDeletionRequiresOriginalRequestAndWorkerReceipt(t *testing.T) {
	f, out, _ := registeredBot(t)
	ctx := context.Background()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	f.s.files = files
	request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
	deleted, err := f.s.DeleteBot(ctx, f.p, out.Bot.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.Deletion == nil || deleted.Deletion.WorkerCleanup.State != "pending" || deleted.Deletion.ServerCleanup.State != "pending" {
		t.Fatalf("premature completion: %+v", deleted)
	}
	if _, _, _, err = f.s.BrowserPoll(ctx, f.p, "", "", out.Session.SessionID, ""); err == nil {
		t.Fatal("deleted history accessible")
	}
	if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	wrong := request
	wrong.DeletionID = uuid.NewString()
	if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, wrong); err == nil {
		t.Fatal("different deletion accepted")
	}
	receipt := BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}, Stop: &sp.TestStop{Protocol: sp.Protocol, Fence: out.Session.Fence, ControllerID: out.Session.Identity.ControllerID, ControllerInstanceID: out.Session.Identity.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: out.Session.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
	if _, err = f.s.CompleteBotDeletion(ctx, f.p, uuid.NewString(), out.Bot.ID, receipt); err == nil {
		t.Fatal("wrong worker accepted")
	}
	done, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil {
		t.Fatal(err)
	}
	if done.Deletion.WorkerCleanup.State != "completed" || done.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("not completed: %+v", done.Deletion)
	}
	var count int
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, out.Bot.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("session retained: %d %v", count, err)
	}
	if _, err = f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt); err != nil {
		t.Fatal(err)
	}
	receipt.Stop.StopProof.RecordID = uuid.NewString()
	if _, err = f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt); err == nil {
		t.Fatal("different receipt accepted")
	}
}

type failedBotFiles struct {
	filestorage.Storage
	fail bool
}

func (f *failedBotFiles) DeleteSessionArchives(ctx context.Context, namespace sessionarchive.Namespace) error {
	if f.fail {
		return errors.New("injected file failure")
	}
	return f.Storage.DeleteSessionArchives(ctx, namespace)
}
func botCleanupReceipt(out BotRegistrationResult, deletionID string) BotDeletionReceipt {
	return BotDeletionReceipt{DeletionID: deletionID, Result: model.BotCleanupResult{State: "completed"}, Stop: &sp.TestStop{Protocol: sp.Protocol, Fence: out.Session.Fence, ControllerID: out.Session.Identity.ControllerID, ControllerInstanceID: out.Session.Identity.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: out.Session.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
}
func TestBotDeletionCleansEveryChildAndOrphanWithRetry(t *testing.T) {
	for _, failure := range []string{"files", "sql"} {
		t.Run(failure, func(t *testing.T) {
			f, out, _ := registeredBot(t)
			ctx := context.Background()
			id := out.Session.SessionID
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			wrapped := &failedBotFiles{Storage: files, fail: failure == "files"}
			f.s.files = wrapped
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{}')`, []any{id}},
				{`INSERT INTO session_timeline(session_id,entry_id,entry_seq,revision,entry) VALUES($1,$2,1,1,'{}')`, []any{id, uuid.NewString()}},
				{`INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'a','{}',$3,$4,'pat','{}')`, []any{id, uuid.NewString(), f.p.UserID, f.p.CredentialID}},
				{`INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,'{}','private')`, []any{id, uuid.NewString()}},
				{`INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, []any{id}},
				{`INSERT INTO session_recording_evidence(session_id,execution_generation,evidence_id,revision,body_hash) VALUES($1,1,$2,1,$3)`, []any{id, uuid.NewString(), strings.Repeat("a", 64)}},
			} {
				if _, err = f.s.DB.Pool.Exec(ctx, q.sql, q.args...); err != nil {
					t.Fatal(err)
				}
			}
			other := uuid.NewString()
			for _, path := range []string{testArchiveDirectory(t, "", f.p.UserID, id) + "/orphan.json", testArchiveDirectory(t, "", f.p.UserID, other) + "/keep.json"} {
				if _, err = files.Put(ctx, archiveBucket, path, strings.NewReader("private")); err != nil {
					t.Fatal(err)
				}
			}
			request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
			if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
				t.Fatal(err)
			}
			if failure == "sql" {
				if _, err = f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION refuse_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected SQL failure'; END $$; CREATE TRIGGER refuse_cleanup BEFORE DELETE ON session_resources FOR EACH ROW EXECUTE FUNCTION refuse_cleanup()`); err != nil {
					t.Fatal(err)
				}
			}
			receipt := botCleanupReceipt(out, request.DeletionID)
			failed, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
			if err != nil || failed.Deletion.ServerCleanup.State != "failed" || failed.Deletion.WorkerCleanup.State != "completed" {
				t.Fatalf("failure lost: %+v %v", failed, err)
			}
			for _, table := range append(append([]string{}, botSessionChildren...), "task_sessions") {
				var n int
				column := "session_id"
				if table == "task_sessions" {
					column = "id"
				}
				if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+column+`=$1`, id).Scan(&n); err != nil || n != 1 {
					t.Fatalf("failed cleanup did not retain %s: %d %v", table, n, err)
				}
			}
			if failure == "sql" {
				if _, err = f.s.DB.Pool.Exec(ctx, `DROP TRIGGER refuse_cleanup ON session_resources; DROP FUNCTION refuse_cleanup()`); err != nil {
					t.Fatal(err)
				}
			} else {
				wrapped.fail = false
			}
			done, err := f.s.DeleteBot(ctx, f.p, out.Bot.ID, request)
			if err != nil || done.Deletion.ServerCleanup.State != "completed" {
				t.Fatalf("retry: %+v %v", done, err)
			}
			for _, table := range append(append([]string{}, botSessionChildren...), "task_sessions") {
				var n int
				column := "session_id"
				if table == "task_sessions" {
					column = "id"
				}
				if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+column+`=$1`, id).Scan(&n); err != nil || n != 0 {
					t.Fatalf("retained %s: %d %v", table, n, err)
				}
			}
			if _, err = files.Open(ctx, archiveBucket, testArchiveDirectory(t, "", f.p.UserID, id)+"/orphan.json"); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("orphan remains: %v", err)
			}
			if object, openErr := files.Open(ctx, archiveBucket, testArchiveDirectory(t, "", f.p.UserID, other)+"/keep.json"); openErr != nil {
				t.Fatal("unrelated namespace removed", openErr)
			} else {
				_ = object.Body.Close()
			}
			var tasks int
			if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE id=$1`, f.task).Scan(&tasks); err != nil || tasks != 1 {
				t.Fatal("task removed", err)
			}
		})
	}
}

func TestBotDeletionCleansCurrentHistoryAndPreservesExistingUnrelatedBytes(t *testing.T) {
	f, out, _ := registeredBot(t)
	ctx := t.Context()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	f.s.files = files
	existing := out.Session.SessionID + "/orphan.json"
	current := testArchiveDirectory(t, "", f.p.UserID, out.Session.SessionID) + "/history.json"
	for _, name := range []string{existing, current} {
		if _, err := files.Put(ctx, archiveBucket, name, strings.NewReader("private history")); err != nil {
			t.Fatal(err)
		}
	}
	request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
	if _, err := f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	result, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, botCleanupReceipt(out, request.DeletionID))
	if err != nil || result.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("current history cleanup did not complete: %+v %v", result, err)
	}
	if _, err := files.Open(ctx, archiveBucket, current); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("current archive history remains: %v", err)
	}
	object, err := files.Open(ctx, archiveBucket, existing)
	if err != nil {
		t.Fatal("cleanup changed existing unrelated bytes", err)
	}
	content, readErr := io.ReadAll(object.Body)
	if err := errors.Join(readErr, object.Body.Close()); err != nil {
		t.Fatal(err)
	}
	if string(content) != "private history" {
		t.Fatalf("cleanup changed existing unrelated bytes: %q", content)
	}
}

func TestBotDeletionReceiptRejectsUnprovenOrStaleExecution(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx := context.Background()
	request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
	if _, err := f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	receipt := botCleanupReceipt(out, request.DeletionID)
	if _, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt); err == nil {
		t.Fatal("connected execution claimed never started")
	}
	receipt.Stop.StopProof.Kind = ""
	good := *receipt.Stop
	for _, change := range []func(*sp.TestStop){func(s *sp.TestStop) { s.ExecutionGeneration = "2" }, func(s *sp.TestStop) { s.ControllerID = uuid.NewString() }, func(s *sp.TestStop) { s.StopProof.PreviousControllerInstanceID = uuid.NewString() }, func(s *sp.TestStop) { s.StopProof.StoppedAt = time.Now().Add(time.Hour).Format(time.RFC3339Nano) }} {
		bad := good
		change(&bad)
		receipt.Stop = &bad
		if _, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt); err == nil {
			t.Fatal("invalid stop accepted")
		}
	}
	code := "process_not_stopped"
	receipt.Stop = nil
	receipt.Result = model.BotCleanupResult{State: "failed", Code: &code}
	failed, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil || failed.Deletion.WorkerCleanup.State != "failed" || failed.Deletion.ServerCleanup.State != "pending" {
		t.Fatalf("failed stop: %+v %v", failed, err)
	}
	replayed, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil || replayed.Version != failed.Version || !replayed.UpdatedAt.Equal(failed.UpdatedAt) {
		t.Fatalf("identical failed receipt changed its result: %+v %v", replayed, err)
	}
	changedCode := "private_cleanup_failed"
	receipt.Result.Code = &changedCode
	changed, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil || changed.Version != failed.Version+1 || changed.Deletion.WorkerCleanup.Code == nil || *changed.Deletion.WorkerCleanup.Code != changedCode {
		t.Fatalf("changed failure did not advance: %+v %v", changed, err)
	}
	receipt.Stop = &good
	receipt.Result = model.BotCleanupResult{State: "completed"}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	f.s.files = files
	done, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil || done.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("valid stop retry: %+v %v", done, err)
	}
}

func TestBotDeletionCleansResidualAssociationsBeyondCurrentSession(t *testing.T) {
	f, out, _ := registeredBot(t)
	ctx := context.Background()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	f.s.files = files
	// Fault injection models a historical leftover despite the current unique
	// association constraint; cleanup must enumerate ownership, not the pointer.
	if _, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE task_sessions DROP CONSTRAINT session_bot_identity`); err != nil {
		t.Fatal(err)
	}
	residual := uuid.NewString()
	if _, err = f.s.DB.Pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,bot_id) SELECT $2,scope,$3,owner_user_id,$4,registration,snapshot,parent_credential_id,bot_id FROM task_sessions WHERE id=$1`, out.Session.SessionID, residual, uuid.NewString(), uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{out.Session.SessionID, residual} {
		if _, err = files.Put(ctx, archiveBucket, testArchiveDirectory(t, "", f.p.UserID, id)+"/orphan.json", strings.NewReader("private")); err != nil {
			t.Fatal(err)
		}
	}
	request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
	if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	done, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, botCleanupReceipt(out, request.DeletionID))
	if err != nil || done.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("cleanup: %+v %v", done, err)
	}
	var count int
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, out.Bot.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("residual sessions %d: %v", count, err)
	}
	for _, id := range []string{out.Session.SessionID, residual} {
		if object, err := files.Open(ctx, archiveBucket, testArchiveDirectory(t, "", f.p.UserID, id)+"/orphan.json"); !errors.Is(err, fs.ErrNotExist) {
			if err == nil {
				_ = object.Body.Close()
			}
			t.Fatalf("residual archive %s: %v", id, err)
		}
	}
}
