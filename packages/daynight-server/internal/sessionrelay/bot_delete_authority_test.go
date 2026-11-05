package sessionrelay

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func deletionAuthorityState(t *testing.T, f fixture, id string) string {
	t.Helper()
	var state string
	if err := f.s.DB.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('version',version,'deletion',deletion)::text FROM bots WHERE id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestBotDeletionRejectsUnauthorizedActorsWithoutChangingResponsibility(t *testing.T) {
	for _, phase := range []string{"intent", "receipt"} {
		for _, actor := range []string{"revoked", "expired", "other_owner"} {
			t.Run(phase+"/"+actor, func(t *testing.T) {
				f, bot, _ := botFixture(t)
				ctx := context.Background()
				request := service.DeleteBot{Version: bot.Version, DeletionID: uuid.NewString()}
				if phase == "receipt" {
					if _, err := f.s.DeleteBot(ctx, f.p, bot.ID, request); err != nil {
						t.Fatal(err)
					}
				}
				before := deletionAuthorityState(t, f, bot.ID)
				principal := f.p
				want := "unauthenticated"
				switch actor {
				case "revoked":
					if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
						t.Fatal(err)
					}
				case "expired":
					if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1`, f.p.CredentialID); err != nil {
						t.Fatal(err)
					}
				case "other_owner":
					principal, want = addMember(t, f, "admin"), "forbidden"
				}
				var err error
				if phase == "intent" {
					_, err = f.s.DeleteBot(ctx, principal, bot.ID, request)
				} else {
					_, err = f.s.CompleteBotDeletion(ctx, principal, bot.WorkerID, bot.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}})
				}
				botFault(t, err, want)
				if after := deletionAuthorityState(t, f, bot.ID); after != before {
					t.Fatalf("unauthorized %s changed deletion responsibility: %s -> %s", phase, before, after)
				}
			})
		}
	}
}

func TestBotDeletionUnknownIdentityAndStaleVersionLeaveOriginalBotUnchanged(t *testing.T) {
	f, bot, _ := botFixture(t)
	ctx := context.Background()
	before := deletionAuthorityState(t, f, bot.ID)
	request := service.DeleteBot{Version: bot.Version, DeletionID: uuid.NewString()}
	_, err := f.s.DeleteBot(ctx, f.p, uuid.NewString(), request)
	botFault(t, err, "not_found")
	_, err = f.s.CompleteBotDeletion(ctx, f.p, bot.WorkerID, uuid.NewString(), BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}})
	botFault(t, err, "not_found")
	request.Version++
	_, err = f.s.DeleteBot(ctx, f.p, bot.ID, request)
	botFault(t, err, "version_conflict")
	if after := deletionAuthorityState(t, f, bot.ID); after != before {
		t.Fatalf("unknown identity or stale version changed existing Bot: %s -> %s", before, after)
	}
}

func TestBotDeletionVersionExhaustionRollsBackAdmissionRevocation(t *testing.T) {
	f, out, _ := registeredBot(t)
	ctx := context.Background()
	v := out.Session
	if _, err := f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "bootstrap"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE bots SET version=$2 WHERE id=$1`, out.Bot.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	before := deletionAuthorityState(t, f, out.Bot.ID)
	_, err := f.s.DeleteBot(ctx, f.p, out.Bot.ID, service.DeleteBot{Version: math.MaxInt64, DeletionID: uuid.NewString()})
	botFault(t, err, "version_exhausted")
	if after := deletionAuthorityState(t, f, out.Bot.ID); after != before {
		t.Fatalf("exhaustion persisted a deletion intent: %s -> %s", before, after)
	}
	var authorized bool
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT grant_hash IS NOT NULL AND grant_expires_at IS NOT NULL FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&authorized); err != nil || !authorized {
		t.Fatalf("failed intent revoked the existing grant: %v %v", authorized, err)
	}
	if _, err := f.s.TestSnapshot(ctx, f.p, v.SessionID); err != nil {
		t.Fatal("failed intent blocked the existing Session", err)
	}
}

func TestBotDeletionDatabaseWriteFailurePreservesRetryableStage(t *testing.T) {
	for _, phase := range []string{"intent", "receipt"} {
		t.Run(phase, func(t *testing.T) {
			f, out, _ := registeredBot(t)
			ctx := context.Background()
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			f.s.files = files
			request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
			receipt := botCleanupReceipt(out, request.DeletionID)
			if phase == "receipt" {
				if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
					t.Fatal(err)
				}
			}
			before := deletionAuthorityState(t, f, out.Bot.ID)
			if _, err = f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION refuse_bot_deletion_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected Bot deletion write failure'; END $$; CREATE TRIGGER refuse_bot_deletion_write BEFORE UPDATE OF deletion ON bots FOR EACH ROW EXECUTE FUNCTION refuse_bot_deletion_write()`); err != nil {
				t.Fatal(err)
			}
			if phase == "intent" {
				_, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request)
			} else {
				_, err = f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
			}
			var failure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Code != "P0001" {
				t.Fatalf("database failure became successful deletion: %v", err)
			}
			if after := deletionAuthorityState(t, f, out.Bot.ID); after != before {
				t.Fatalf("failed write advanced %s: %s -> %s", phase, before, after)
			}
			var sessions int
			if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, out.Bot.ID).Scan(&sessions); err != nil || sessions != 1 {
				t.Fatalf("failed write removed the Session needed for retry: %d %v", sessions, err)
			}
			_, snapshotErr := f.s.TestSnapshot(ctx, f.p, out.Session.SessionID)
			if phase == "receipt" {
				botFault(t, snapshotErr, "resource_conflict")
			} else if snapshotErr != nil {
				t.Fatal("rolled-back intent still blocks access", snapshotErr)
			}
			if _, err = f.s.DB.Pool.Exec(ctx, `DROP TRIGGER refuse_bot_deletion_write ON bots; DROP FUNCTION refuse_bot_deletion_write()`); err != nil {
				t.Fatal(err)
			}
			if phase == "intent" {
				if _, err = f.s.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
					t.Fatal("original intent could not retry", err)
				}
			}
			done, err := f.s.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
			if err != nil || done.Deletion == nil || done.Deletion.WorkerCleanup.State != "completed" || done.Deletion.ServerCleanup.State != "completed" {
				t.Fatalf("original receipt could not complete after repair: %+v %v", done.Deletion, err)
			}
		})
	}
}
