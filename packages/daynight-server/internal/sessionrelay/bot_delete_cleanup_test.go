package sessionrelay

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/google/uuid"
)

func TestBotDeletionCleanupFailureRetainsReceiptAndCanRetry(t *testing.T) {
	for _, failure := range []string{"missing_storage", "session_delete", "bot_minimization"} {
		t.Run(failure, func(t *testing.T) {
			f, out, _ := registeredBot(t)
			ctx := context.Background()
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			f.s.files = files
			request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
			if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
				t.Fatal(err)
			}
			var table string
			switch failure {
			case "missing_storage":
				f.s.files = nil
			case "session_delete":
				table = "task_sessions"
				_, err = f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION refuse_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected parent deletion failure'; END $$; CREATE TRIGGER refuse_cleanup BEFORE DELETE ON task_sessions FOR EACH ROW EXECUTE FUNCTION refuse_cleanup()`)
			case "bot_minimization":
				table = "bots"
				_, err = f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION refuse_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected minimization failure'; END $$; CREATE TRIGGER refuse_cleanup BEFORE UPDATE OF name ON bots FOR EACH ROW EXECUTE FUNCTION refuse_cleanup()`)
			}
			if err != nil {
				t.Fatal(err)
			}
			receipt := botCleanupReceipt(out, request.DeletionID)
			failed, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
			if err != nil {
				t.Fatal(err)
			}
			if failed.Deletion.WorkerCleanup.State != "completed" || failed.Deletion.ReceiptDigest == "" || failed.Deletion.ServerCleanup.State != "failed" || failed.SessionID == nil {
				t.Fatalf("cleanup failure lost responsibility: %+v", failed)
			}
			var count int
			if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE id=$1`, out.Session.SessionID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("failed cleanup did not roll back Session removal: %d %v", count, err)
			}
			_, err = f.s.TestSnapshot(ctx, f.p, out.Session.SessionID)
			botFault(t, err, "resource_conflict")
			if table != "" {
				if _, err = f.s.DB.Pool.Exec(ctx, `DROP TRIGGER refuse_cleanup ON `+table+`; DROP FUNCTION refuse_cleanup()`); err != nil {
					t.Fatal(err)
				}
			}
			f.s.files = files
			done, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
			if err != nil || done.Deletion.ServerCleanup.State != "completed" || done.SessionID != nil {
				t.Fatalf("original receipt could not recover: %+v %v", done, err)
			}
			if done.Deletion.ReceiptDigest != failed.Deletion.ReceiptDigest {
				t.Fatal("retry replaced Worker receipt")
			}
		})
	}
}

func TestBotDeletionCleanupRechecksAuthorityAndPriorCompletion(t *testing.T) {
	f, out, _ := registeredBot(t)
	ctx := context.Background()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	f.s.files = files
	request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
	// The cleanup transaction must recheck the intent and authority even when
	// its caller has already checked them in a preceding transaction.
	_, err = f.s.cleanBotDeletion(ctx, f.p, out.Bot.ID, request.DeletionID)
	botFault(t, err, "session_conflict")
	if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.cleanBotDeletion(ctx, f.p, out.Bot.ID, request.DeletionID)
	botFault(t, err, "session_conflict")
	other := addMember(t, f, "admin")
	_, err = f.s.cleanBotDeletion(ctx, other, out.Bot.ID, request.DeletionID)
	botFault(t, err, "forbidden")
	done, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, botCleanupReceipt(out, request.DeletionID))
	if err != nil {
		t.Fatal(err)
	}
	// Another accepted call may arrive after the first cleanup has committed.
	replayed, err := f.s.cleanBotDeletion(ctx, f.p, out.Bot.ID, request.DeletionID)
	if err != nil || replayed.Version != done.Version || !replayed.UpdatedAt.Equal(done.UpdatedAt) {
		t.Fatalf("concurrent completion advanced the result: %+v %v", replayed, err)
	}
	_, err = f.s.cleanBotDeletion(ctx, f.p, out.Bot.ID, uuid.NewString())
	botFault(t, err, "session_conflict")
}

func TestBotDeletionCleanupRefusesInconsistentResidualOwnership(t *testing.T) {
	f, out, _ := registeredBot(t)
	ctx := context.Background()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	f.s.files = files
	other := addMember(t, f, "admin")
	// Model corrupt historical association data without weakening the normal
	// schema. Cleanup must independently refuse to delete another owner's row.
	if _, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE task_sessions DROP CONSTRAINT session_bot_identity, DROP CONSTRAINT session_bot_owner`); err != nil {
		t.Fatal(err)
	}
	residual := uuid.NewString()
	if _, err = f.s.DB.Pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,bot_id) SELECT $2,scope,$3,$5,$4,registration,snapshot,parent_credential_id,bot_id FROM task_sessions WHERE id=$1`, out.Session.SessionID, residual, uuid.NewString(), uuid.NewString(), other.UserID); err != nil {
		t.Fatal(err)
	}
	request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
	if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	receipt := botCleanupReceipt(out, request.DeletionID)
	failed, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil || failed.Deletion.WorkerCleanup.State != "completed" || failed.Deletion.ServerCleanup.State != "failed" {
		t.Fatalf("inconsistent owner was not retained: %+v %v", failed, err)
	}
	var count int
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, out.Bot.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("owner mismatch removed rows: %d %v", count, err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET owner_user_id=$2 WHERE id=$1`, residual, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	done, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
	if err != nil || done.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("repaired association could not retry: %+v %v", done, err)
	}
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, out.Bot.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("repaired association retained rows: %d %v", count, err)
	}
}
