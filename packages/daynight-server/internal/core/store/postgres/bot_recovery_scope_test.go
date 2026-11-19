package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestBotRecoveryScopeCommitsHostingAuthorizationAndReceiptAtomically(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	bot := runtimeStoredBot(t, database)
	oldPAT, currentPAT := runtimeBotPAT(t, database, bot), runtimeBotPAT(t, database, bot)
	newWorker := uuid.NewString()
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(bot.OwnerUserID, newWorker, time.Now().UTC()))
	sessionID, executionID, nativeID := uuid.NewString(), uuid.NewString(), "original-native-session"
	initial := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, TestExecutionID: executionID, ExecutionGeneration: "3"}, ConnectionEpoch: "5"},
		Identity:  sp.Identity{OwnerUserID: bot.OwnerUserID, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), NativeSessionID: &nativeID, Provider: "codex"},
		Lifecycle: "active", ConnectionState: "connected", Synchronized: true}
	oldHash, newHash := bytes.Repeat([]byte{4}, 32), bytes.Repeat([]byte{8}, 32)
	expiry := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		inserted, err := scope.SessionDAO().InsertBotSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: sessionID}, TestExecutionID: executionID, OwnerID: bot.OwnerUserID, RegistrationID: uuid.NewString(), Registration: json.RawMessage(`{}`), Snapshot: initial, ParentCredentialID: oldPAT.CredentialID, BotID: &bot.ID})
		if err != nil {
			return err
		}
		if !inserted {
			t.Fatal("fixture Session was not inserted")
		}
		bot, err = scope.BotDAO().BindBotSession(ctx, bot.ID, 1, sessionID, model.BotRoleConfiguration{})
		if err != nil {
			return err
		}
		bot, err = scope.BotDAO().RegisterBotRecovery(ctx, bot.ID, bot.Version, model.BotRecovery{ServiceOrigin: "https://daynight.example", MachineID: "same-machine", MachineName: "Host", IdentityHash: bytes.Repeat([]byte{2}, 32), HostingGeneration: 1})
		if err != nil {
			return err
		}
		if err := scope.SessionDAO().SetSessionGrant(ctx, store.SessionGrant{SessionID: sessionID, Hash: oldHash, ExpiresAt: expiry, Kind: "reconnect", ParentCredentialID: oldPAT.CredentialID}); err != nil {
			return err
		}
		return scope.SessionDAO().ConnectSession(ctx, sessionID, uuid.NewString(), time.Now().UTC(), &expiry)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("fixture commit: %+v %v", completion, err)
	}
	mustQueryExec(t, database, `DELETE FROM personal_access_tokens WHERE id=$1`, oldPAT.CredentialID)
	_, err = database.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().LockCredential(ctx, oldPAT, time.Now().UTC())
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked original PAT retained authority: %v", err)
	}
	// Existing business claims remain owned by their Task and Bot, independently
	// of the Worker carrying the Bot's Session.
	project := queryProject(t, database, 70)
	ordinary := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 71, bot.OwnerUserID, bot.WorkerID)
	assistantTaskID := uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO assistant_tasks(id,owner_user_id,request_fingerprint,application,name,purpose,scope,kind,state,takeover,version,manual_version,claim_generation,holder_bot_id,claim_token_hash,credential_operation_id,claimed_at,renewed_at,lease_until,created_at,updated_at)
 VALUES($1,$2,'fingerprint','','Business task','Purpose','Scope','continuous','active','auto',1,1,7,$3,'unchanged-business-credential',$4,now(),now(),now()+interval '1 hour',now(),now())`, assistantTaskID, bot.OwnerUserID, bot.ID, uuid.NewString())
	claimState := func() string {
		var state string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('ordinary',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.name) FROM task_properties p WHERE task_id=$1),'assistant',(SELECT to_jsonb(a) FROM assistant_tasks a WHERE id=$2))::text`, ordinary.TaskID, assistantTaskID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	claimsBefore := claimState()
	operation := store.BotRecoveryOperation{OperationID: uuid.NewString(), Kind: "takeover", RequestHash: bytes.Repeat([]byte{3}, 32), Receipt: json.RawMessage(`{"hostingGeneration":"2"}`)}
	failure := errors.New("reject recovery after both DAO writes")
	mutate := func(stop bool) (store.Completion, error) {
		return database.WriteSession(ctx, func(scope store.SessionScope) error {
			if err := scope.SessionDAO().LockCredential(ctx, currentPAT, time.Now().UTC()); err != nil {
				return err
			}
			if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
				return err
			}
			record, err := scope.SessionDAO().LockSession(ctx, sessionID)
			if err != nil {
				return err
			}
			if _, err := scope.BotDAO().AdvanceBotRecovery(ctx, bot.ID, bot.Version, 1, newWorker, model.WorkerMachine{ID: "same-machine", Name: "Renamed"}); err != nil {
				return err
			}
			if err := scope.SessionDAO().DisconnectSession(ctx, sessionID); err != nil {
				return err
			}
			if err := scope.SessionDAO().SetSessionGrant(ctx, store.SessionGrant{SessionID: sessionID, Hash: newHash, ExpiresAt: expiry, Kind: "reconnect", ParentCredentialID: currentPAT.CredentialID}); err != nil {
				return err
			}
			record.Snapshot.ConnectionState, record.Snapshot.Synchronized = "disconnected", false
			if err := scope.SessionDAO().SaveSession(ctx, record); err != nil {
				return err
			}
			if err := scope.BotDAO().SaveBotRecoveryOperation(ctx, bot.ID, operation); err != nil {
				return err
			}
			if stop {
				return failure
			}
			return nil
		})
	}
	check := func(committed bool) {
		t.Helper()
		completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
			current, err := scope.BotDAO().Bot(ctx, bot.ID)
			if err != nil {
				return err
			}
			record, err := scope.SessionDAO().LockSession(ctx, sessionID)
			if err != nil {
				return err
			}
			if record.Snapshot.ControllerFence != initial.ControllerFence || !reflect.DeepEqual(record.Snapshot.Identity, initial.Identity) {
				t.Fatal("takeover replaced original Session or native identity")
			}
			if committed {
				if current.WorkerID != bot.WorkerID || current.Recovery.WorkerID != newWorker || current.Version != bot.Version+1 || current.Recovery.HostingGeneration != 2 || record.Parent != currentPAT.CredentialID || record.ConnectionExpiry != nil || !bytes.Equal(record.GrantHash, newHash) || record.Snapshot.Synchronized || record.Snapshot.ConnectionState != "disconnected" {
					t.Fatalf("partial recovery commit: Bot=%+v Session=%+v", current, record)
				}
				got, err := scope.BotDAO().BotRecoveryOperation(ctx, bot.ID, operation.OperationID)
				if err != nil {
					return err
				}
				if got.Kind != operation.Kind || !bytes.Equal(got.RequestHash, operation.RequestHash) {
					t.Fatal("committed operation receipt changed")
				}
			} else {
				if current.WorkerID != bot.WorkerID || current.Recovery.WorkerID != bot.WorkerID || current.Version != bot.Version || current.Recovery.HostingGeneration != 1 || record.Parent != oldPAT.CredentialID || record.ConnectionExpiry == nil || !bytes.Equal(record.GrantHash, oldHash) || !record.Snapshot.Synchronized {
					t.Fatalf("recovery rollback lost original authority: Bot=%+v Session=%+v", current, record)
				}
				if _, err := scope.BotDAO().BotRecoveryOperation(ctx, bot.ID, operation.OperationID); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("rollback retained receipt: %v", err)
				}
			}
			return nil
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("readback: %+v %v", completion, err)
		}
		if claimState() != claimsBefore {
			t.Fatal("Bot host change altered ordinary or assistant business claim")
		}
	}
	completion, err = mutate(true)
	if !errors.Is(err, failure) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	check(false)
	completion, err = mutate(false)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("commit: %+v %v", completion, err)
	}
	check(true)
}
