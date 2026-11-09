package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func sessionDAOTransaction(t *testing.T, db *Store, fn func(store.SessionScope) error) {
	t.Helper()
	completion, err := db.WriteSession(context.Background(), fn)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("session transaction: %+v %v", completion, err)
	}
}

func TestSessionDAORegistrationGrantAndList(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	_, principal, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	now := time.Now().UTC().Truncate(time.Microsecond)
	patID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'test',$4,$5)`, patID, principal.UserID, make([]byte, 32), now.Add(-time.Hour), now.Add(time.Hour))
	pat := model.Principal{Kind: model.PATCredential, UserID: principal.UserID, CredentialID: patID}
	claim, id, registration := uuid.NewString(), uuid.NewString(), uuid.NewString()
	execution, testID, testRegistration := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "active"}
	testSnapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: testID, TestExecutionID: execution, ExecutionGeneration: "1"}}, Lifecycle: "active"}
	hash := []byte("controller-grant-hash")
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.LockCredential(ctx, principal, now); err != nil {
			return err
		}
		if err := dao.LockCredential(ctx, pat, now); err != nil {
			return err
		}
		if err := dao.LockTaskRegistration(ctx, project.ID, task.ID); err != nil {
			return err
		}
		if _, err := dao.LockTask(ctx, project.ID, task.ID); err != nil {
			return err
		}
		if _, err := dao.FindTaskRegistration(ctx, project.ID, registration, task.ID, claim); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing registration: %v", err)
		}
		if err := dao.InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: principal.UserID, RegistrationID: registration, Registration: []byte(`{}`), Snapshot: snapshot}); err != nil {
			return err
		}
		found, err := dao.FindTaskRegistration(ctx, project.ID, registration, task.ID, claim)
		if err != nil || found != id {
			t.Fatalf("task registration: %q %v", found, err)
		}
		current, err := dao.CurrentTaskSession(ctx, project.ID, task.ID, claim)
		if err != nil || current != id {
			t.Fatalf("current: %q %v", current, err)
		}
		if err := dao.LockTestOwner(ctx, principal.UserID); err != nil {
			return err
		}
		if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: testID}, OwnerID: principal.UserID, TestExecutionID: execution, RegistrationID: testRegistration, Registration: []byte(`{}`), Snapshot: testSnapshot, ParentCredentialID: patID}); err != nil {
			return err
		}
		found, botID, err := dao.FindTestRegistration(ctx, principal.UserID, testRegistration, execution)
		if err != nil || found != testID || botID != nil {
			t.Fatalf("test registration: %q %v %v", found, botID, err)
		}
		if err := dao.SetSessionGrant(ctx, store.SessionGrant{SessionID: testID, Hash: hash, ExpiresAt: now.Add(time.Hour), Kind: "bootstrap", ParentCredentialID: patID}); err != nil {
			return err
		}
		location, err := dao.SessionLocationByGrant(ctx, hash)
		if err != nil || location.SessionID != testID || location.ProjectID != "" {
			t.Fatalf("grant location: %+v %v", location, err)
		}
		location, err = dao.SessionLocation(ctx, id)
		if err != nil || location.TaskID != task.ID || location.ProjectID != project.ID {
			t.Fatalf("task location: %+v %v", location, err)
		}
		if err := dao.ConnectSession(ctx, testID, uuid.NewString(), now, ptrTime(now.Add(time.Hour))); err != nil {
			return err
		}
		if err := dao.TouchSession(ctx, testID, now); err != nil {
			return err
		}
		record, err := dao.LockSession(ctx, testID)
		if err != nil || !record.Consumed || record.ConnectionParent != patID || record.ConnectionExpiry == nil || !record.ConnectionExpiry.Equal(now.Add(time.Hour)) {
			t.Fatalf("connection: %+v %v", record, err)
		}
		list, err := dao.ListTestSessions(ctx, principal.UserID, now, 10, true, now.Add(-time.Minute), nil, "")
		if err != nil || len(list) != 1 || list[0].Snapshot.SessionID != testID {
			t.Fatalf("online list: %+v %v", list, err)
		}
		cursor := now.Add(time.Hour)
		list, err = dao.ListTestSessions(ctx, principal.UserID, now, 10, true, now.Add(-time.Minute), &cursor, testID)
		if err != nil || len(list) != 1 {
			t.Fatalf("cursor list: %+v %v", list, err)
		}
		return nil
	})
	var connectedExpiry *time.Time
	if err := db.Pool.QueryRow(ctx, `SELECT connection_expires_at FROM task_sessions WHERE id=$1`, testID).Scan(&connectedExpiry); err != nil || connectedExpiry == nil || !connectedExpiry.Equal(now.Add(time.Hour)) {
		t.Fatalf("committed controller connection expiry: %v %v", connectedExpiry, err)
	}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.DisconnectSession(ctx, testID); err != nil {
			return err
		}
		list, err := dao.ListTestSessions(ctx, principal.UserID, now, 10, true, now.Add(-time.Minute), nil, "")
		if err != nil || len(list) != 0 {
			t.Fatalf("disconnected list: %+v %v", list, err)
		}
		record, err := dao.LockSession(ctx, testID)
		if err != nil || record.ConnectionExpiry != nil {
			t.Fatalf("disconnected controller still has connection expiry: %+v %v", record, err)
		}
		return nil
	})
	var disconnectedExpiry *time.Time
	if err := db.Pool.QueryRow(ctx, `SELECT connection_expires_at FROM task_sessions WHERE id=$1`, testID).Scan(&disconnectedExpiry); err != nil || disconnectedExpiry != nil {
		t.Fatalf("committed controller disconnect retained expiry: %v %v", disconnectedExpiry, err)
	}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.SetSessionGenerationStop(ctx, id, []byte(`{"kind":"stopped"}`)); err != nil {
			return err
		}
		if err := dao.SetTestSessionStop(ctx, testID, []byte(`{"kind":"stopped"}`)); err != nil {
			return err
		}
		record, err := dao.LockSession(ctx, testID)
		if err != nil || record.GrantHash != nil || record.ConnectionExpiry != nil || string(record.StopProof) == "" {
			t.Fatalf("stop: %+v %v", record, err)
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, testID)
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		_, err := scope.SessionDAO().ListTestSessions(ctx, principal.UserID, now, 10, false, now.Add(-time.Minute), nil, "")
		if err == nil {
			t.Fatal("invalid stored test snapshot accepted")
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		_, err := scope.SessionDAO().SessionLocationByGrant(ctx, hash)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("stop left grant usable: %v", err)
		}
		if err := scope.SessionDAO().LockCredential(ctx, pat, now.Add(2*time.Hour)); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expired credential accepted: %v", err)
		}
		return nil
	})
}

func ptrTime(v time.Time) *time.Time { return &v }

func TestSessionDAOLedgerAndArchive(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	_, principal, _ := testAuthRecords(t, db)
	id, execution, registration := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}
	first, response := uuid.NewString(), uuid.NewString()
	interaction := uuid.NewString()
	command := sp.Command{Fence: fence, OperationID: first, Kind: "send_message", Payload: json.RawMessage(`{}`)}
	receipt := sp.Operation{Fence: fence, OperationID: first, Kind: "send_message", State: "accepted"}
	responseCommand := sp.Command{Fence: fence, OperationID: response, Kind: "interaction_response", Payload: json.RawMessage(`{"interactionId":"` + interaction + `"}`)}
	responseReceipt := sp.Operation{Fence: fence, OperationID: response, Kind: "interaction_response", State: "offered"}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: principal.UserID, TestExecutionID: execution, RegistrationID: registration, Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}}, ParentCredentialID: principal.CredentialID}); err != nil {
			return err
		}
		if err := dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: first, Seq: 1, Hash: []byte("first"), Actor: principal, Command: command, Receipt: receipt}); err != nil {
			return err
		}
		if err := dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: response, Seq: 2, Hash: []byte("response"), Actor: principal, Command: responseCommand, Receipt: responseReceipt}); err != nil {
			return err
		}
		loaded, err := dao.SessionOperation(ctx, id, first)
		if err != nil || loaded.Command.Kind != "send_message" || loaded.Actor.UserID != principal.UserID || loaded.Receipt.State != "accepted" {
			t.Fatalf("operation: %+v %v", loaded, err)
		}
		duplicate, err := dao.HasOtherFirstInput(ctx, id, uuid.NewString())
		if err != nil || !duplicate {
			t.Fatalf("first input fence: %v %v", duplicate, err)
		}
		duplicate, err = dao.HasInteractionResponse(ctx, id, uuid.NewString(), interaction)
		if err != nil || !duplicate {
			t.Fatalf("interaction fence: %v %v", duplicate, err)
		}
		count, err := dao.PendingSessionOperationCount(ctx, id)
		if err != nil || count != 2 {
			t.Fatalf("pending: %d %v", count, err)
		}
		accepted, err := dao.AcceptedSessionOperations(ctx, id)
		if err != nil || !reflect.DeepEqual(accepted, []string{first}) {
			t.Fatalf("accepted: %v %v", accepted, err)
		}
		stopping, err := dao.StoppingTestOperations(ctx, id)
		if err != nil || len(stopping) != 2 {
			t.Fatalf("stopping: %v %v", stopping, err)
		}
		if err := dao.SetSessionOperationEpoch(ctx, id, response, 1); err != nil {
			return err
		}
		unresolved, err := dao.UnreconciledSessionOperations(ctx, id, 2)
		if err != nil || !reflect.DeepEqual(unresolved, []string{response}) {
			t.Fatalf("reconcile: %v %v", unresolved, err)
		}
		count, err = dao.UnreconciledSessionOperationCount(ctx, id, 2)
		if err != nil || count != 1 {
			t.Fatalf("reconcile count: %d %v", count, err)
		}
		responseReceipt.State = "rejected"
		if err := dao.SetSessionOperationReceipt(ctx, responseReceipt); err != nil {
			return err
		}
		duplicate, err = dao.HasInteractionResponse(ctx, id, uuid.NewString(), interaction)
		if err != nil || duplicate {
			t.Fatalf("rejected response blocks retry: %v %v", duplicate, err)
		}
		status, _, err := dao.SessionArchive(ctx, id)
		if err != nil || status.State != "unavailable" {
			t.Fatalf("empty archive: %+v %v", status, err)
		}
		if err := dao.SetSessionArchiveState(ctx, id, "pending", nil); err != nil {
			return err
		}
		digest, path := strings.Repeat("a", 64), "users/archive.json"
		if err := dao.SetSessionArchiveReady(ctx, id, digest, 21, path); err != nil {
			return err
		}
		status, gotPath, err := dao.SessionArchive(ctx, id)
		if err != nil || status.SHA256 == nil || *status.SHA256 != digest || gotPath != path {
			t.Fatalf("ready archive: %+v %q %v", status, gotPath, err)
		}
		return nil
	})
}

func TestSessionDAOTerminalLedgerEvidenceAndHistory(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	_, principal, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	mustQueryExec(t, db, `UPDATE tasks SET allow_agents=true WHERE id=$1`, task.ID)
	id, claim, registration, instance := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	operationID, evidenceID, finalID, client := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.LockTaskRegistration(ctx, project.ID, task.ID); err != nil {
			return err
		}
		if err := dao.InsertTerminal(ctx, store.TerminalRegistration{SessionID: id, ProjectID: project.ID, TaskID: task.ID, ClaimID: claim, OwnerID: principal.UserID, RegistrationID: registration, Registration: []byte(`{}`), State: []byte(`{"revision":1}`), LastSeen: now, ServerInstance: instance}); err != nil {
			return err
		}
		found, err := dao.FindTerminalRegistration(ctx, id, project.ID, registration, task.ID, claim)
		if err != nil || found != id {
			t.Fatalf("terminal registration: %q %v", found, err)
		}
		found, err = dao.CurrentTerminalSession(ctx, project.ID, task.ID, claim)
		if err != nil || found != id {
			t.Fatalf("current terminal: %q %v", found, err)
		}
		state, err := dao.LockTerminal(ctx, id)
		if err != nil || !strings.Contains(string(state), `"revision": 1`) {
			t.Fatalf("terminal state: %s %v", state, err)
		}
		if err := dao.SaveTerminal(ctx, id, []byte(`{"revision":2}`), &now, instance); err != nil {
			return err
		}
		allowed, err := dao.TerminalAutomationAllowed(ctx, task.ID)
		if err != nil || !allowed {
			t.Fatalf("automation permission: %v %v", allowed, err)
		}
		op := store.TerminalOperation{SessionID: id, OperationID: operationID, Seq: 1, Hash: []byte("terminal"), Actor: principal, Command: []byte(`{"request":{"browserClientId":"` + client + `"}}`), Result: v2.OperationResult{OperationID: operationID, State: "queued"}, Deadline: now.Add(time.Minute)}
		if err := dao.InsertTerminalOperation(ctx, op); err != nil {
			return err
		}
		pending, err := dao.TerminalInputPending(ctx, id)
		if err != nil || !pending {
			t.Fatalf("pending input: %v %v", pending, err)
		}
		pending, err = dao.TerminalViewerOperationPending(ctx, id, principal.UserID, client)
		if err != nil || !pending {
			t.Fatalf("viewer input: %v %v", pending, err)
		}
		queued, err := dao.QueuedTerminalOperation(ctx, id)
		if err != nil || !reflect.DeepEqual(queued, []string{operationID}) {
			t.Fatalf("queued: %v %v", queued, err)
		}
		loaded, err := dao.TerminalOperation(ctx, id, operationID)
		if err != nil || loaded.Result.State != "queued" || loaded.Actor.UserID != principal.UserID {
			t.Fatalf("terminal operation: %+v %v", loaded, err)
		}
		if err := dao.SetSessionOperationEpoch(ctx, id, operationID, 1); err != nil {
			return err
		}
		if err := dao.SetTerminalOperationResult(ctx, id, v2.OperationResult{OperationID: operationID, State: "dispatching"}); err != nil {
			return err
		}
		if err := dao.InvalidateTerminalOperations(ctx, id); err != nil {
			return err
		}
		loaded, err = dao.TerminalOperation(ctx, id, operationID)
		if err != nil || loaded.Result.State != "unknown" {
			t.Fatalf("dispatch uncertainty: %+v %v", loaded, err)
		}
		op.OperationID = uuid.NewString()
		op.Seq = 2
		op.Result = v2.OperationResult{OperationID: op.OperationID, State: "queued"}
		op.Deadline = now.Add(-time.Second)
		if err := dao.InsertTerminalOperation(ctx, op); err != nil {
			return err
		}
		if err := dao.ExpireTerminalOperations(ctx, id, now); err != nil {
			return err
		}
		loaded, err = dao.TerminalOperation(ctx, id, op.OperationID)
		if err != nil || loaded.Result.State != "rejected" {
			t.Fatalf("queued expiry: %+v %v", loaded, err)
		}
		hash := strings.Repeat("b", 64)
		if err := dao.InsertRecordingEvidence(ctx, id, 1, evidenceID, 7, hash); err != nil {
			return err
		}
		gotHash, revision, err := dao.TerminalRecordingEvidence(ctx, id, 1, evidenceID)
		if err != nil || gotHash != hash || revision != "7" {
			t.Fatalf("evidence: %s %s %v", gotHash, revision, err)
		}
		if err := dao.SaveTerminalArchiveStatus(ctx, id, v2.ArchiveStatus{State: "pending", FinalizationID: &finalID}); err != nil {
			return err
		}
		status, receipt, path, err := dao.TerminalArchive(ctx, id)
		if err != nil || status.State != "pending" || receipt != nil || path != "" {
			t.Fatalf("pending archive: %+v %+v %q %v", status, receipt, path, err)
		}
		saved := v2.Receipt{FinalizationID: finalID, Disposition: "unavailable"}
		if err := dao.SaveTerminalReceipt(ctx, id, saved, nil); err != nil {
			return err
		}
		status, receipt, _, err = dao.TerminalArchive(ctx, id)
		if err != nil || status.State != "unavailable" || receipt == nil || receipt.FinalizationID != finalID {
			t.Fatalf("archive receipt: %+v %+v %v", status, receipt, err)
		}
		history, err := dao.TerminalHistory(ctx, project.ID, task.ID, nil, nil, 10)
		if err != nil || len(history) != 1 || history[0].ID != id || history[0].Backend != "herdr" {
			t.Fatalf("history: %+v %v", history, err)
		}
		return nil
	})
}

func TestSessionDAOBotDeletionCleanupCanRollBackAndRetry(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	bot, principal := storedBotCandidate(t, db)
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error { return scope.BotDAO().InsertBot(ctx, bot) })
	id, execution, registration := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence, ConnectionEpoch: "0"}, Identity: sp.Identity{OwnerUserID: principal.UserID}}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		current, err := scope.BotDAO().Bot(ctx, bot.ID)
		if err != nil {
			return err
		}
		inserted, err := scope.SessionDAO().InsertBotSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: principal.UserID, TestExecutionID: execution, RegistrationID: registration, Registration: []byte(`{}`), Snapshot: snapshot, ParentCredentialID: principal.CredentialID, BotID: &bot.ID})
		if err != nil || !inserted {
			t.Fatalf("bind insert: %v %v", inserted, err)
		}
		role := model.BotRoleConfiguration{Instructions: "Frozen role", Revision: "1", Digest: strings.Repeat("a", 64)}
		_, err = scope.BotDAO().BindBotSession(ctx, bot.ID, current.Version, id, role)
		return err
	})
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		sessions, err := dao.LockBotSessions(ctx, bot.ID)
		if err != nil || len(sessions) != 1 || sessions[0].ID != id || sessions[0].Owner != principal.UserID || sessions[0].Scope != "test" {
			t.Fatalf("locked sessions: %+v %v", sessions, err)
		}
		owner, err := dao.SessionBotID(ctx, id)
		if err != nil || owner == nil || *owner != bot.ID {
			t.Fatalf("binding: %v %v", owner, err)
		}
		if err := dao.SetSessionGrant(ctx, store.SessionGrant{SessionID: id, Hash: []byte("bot grant"), ExpiresAt: time.Now().Add(time.Hour), Kind: "bootstrap", ParentCredentialID: principal.CredentialID}); err != nil {
			return err
		}
		if err := dao.RevokeBotSessions(ctx, bot.ID); err != nil {
			return err
		}
		proof, err := dao.LockBotSessionStop(ctx, id, bot.ID, principal.UserID)
		if err != nil || proof.Snapshot.Fence != fence || proof.Consumed || proof.SourceEpoch != nil {
			t.Fatalf("stop proof: %+v %v", proof, err)
		}
		opID := uuid.NewString()
		if err := dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: opID, Seq: 1, Hash: []byte("child"), Actor: principal, Command: sp.Command{Fence: fence, OperationID: opID, Kind: "send_message", Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{Fence: fence, OperationID: opID, State: "accepted"}}); err != nil {
			return err
		}
		return dao.InsertRecordingEvidence(ctx, id, 1, uuid.NewString(), 1, strings.Repeat("c", 64))
	})
	rollback := errors.New("cleanup failed")
	for _, caller := range []model.Principal{principal, runtimeBotPAT(t, db, bot)} {
		if err := runtimeBotWriteAfterLock(t, db, bot, caller, runtimeDefinitionCredential, true, func(ctx context.Context, dao store.BotWriteDAO, _ pgx.Tx) error {
			_, err := dao.SaveBotDeletion(ctx, bot.ID, &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}})
			return err
		}); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expired deletion intent credential: kind=%s error=%v", caller.Kind, err)
		}
		if err := runtimeBotWriteAfterLock(t, db, bot, caller, runtimeDefinitionCredential, true, func(ctx context.Context, dao store.BotWriteDAO, _ pgx.Tx) error {
			_, err := dao.Bot(ctx, bot.ID)
			return err
		}); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expired deletion replay credential: kind=%s error=%v", caller.Kind, err)
		}
	}
	completion, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		if _, err := scope.SessionDAO().LockBotSessions(ctx, bot.ID); err != nil {
			return err
		}
		if err := scope.SessionDAO().DeleteBotSession(ctx, id, bot.ID); err != nil {
			return err
		}
		if err := scope.SessionDAO().RedactDeletedBot(ctx, bot.ID); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("cleanup rollback: %+v %v", completion, err)
	}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		current, err := scope.BotDAO().Bot(ctx, bot.ID)
		if err != nil || current.SessionID == nil || *current.SessionID != id {
			t.Fatalf("binding lost on rollback: %+v %v", current, err)
		}
		sessions, err := scope.SessionDAO().LockBotSessions(ctx, bot.ID)
		if err != nil || len(sessions) != 1 {
			t.Fatalf("session lost on rollback: %+v %v", sessions, err)
		}
		count, err := scope.SessionDAO().PendingSessionOperationCount(ctx, id)
		if err != nil || count != 1 {
			t.Fatalf("child lost on rollback: %d %v", count, err)
		}
		if err := scope.SessionDAO().DeleteBotSession(ctx, id, bot.ID); err != nil {
			return err
		}
		return scope.SessionDAO().RedactDeletedBot(ctx, bot.ID)
	})
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		_, err := scope.SessionDAO().LockSession(ctx, id)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted session: %v", err)
		}
		count, err := scope.SessionDAO().PendingSessionOperationCount(ctx, id)
		if err != nil || count != 0 {
			t.Fatalf("session child survived: %d %v", count, err)
		}
		current, err := scope.BotDAO().Bot(ctx, bot.ID)
		if err != nil || current.SessionID != nil || current.Name != "Deleted" {
			t.Fatalf("redaction: %+v %v", current, err)
		}
		return nil
	})
}

func TestSessionDAOClosedTransactionDoesNotReportSuccess(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	id, other := uuid.NewString(), uuid.NewString()
	principal := model.Principal{Kind: model.SessionCredential, UserID: id, CredentialID: other}
	now := time.Now()
	registration := store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, Snapshot: sp.Snapshot{}}
	op := store.SessionOperation{SessionID: id, OperationID: other, Actor: principal, Command: sp.Command{Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{}}
	terminal := store.TerminalOperation{SessionID: id, OperationID: other, Actor: principal, Command: []byte(`{}`), Result: v2.OperationResult{}}
	for name, run := range map[string]func() error{
		"credential":                func() error { return dao.LockCredential(ctx, principal, now) },
		"task":                      func() error { _, e := dao.LockTask(ctx, id, other); return e },
		"task registration lock":    func() error { return dao.LockTaskRegistration(ctx, id, other) },
		"test owner lock":           func() error { return dao.LockTestOwner(ctx, id) },
		"task registration":         func() error { _, e := dao.FindTaskRegistration(ctx, id, other, id, other); return e },
		"test registration":         func() error { _, _, e := dao.FindTestRegistration(ctx, id, other, id); return e },
		"task insertion":            func() error { return dao.InsertTaskSession(ctx, registration) },
		"test insertion":            func() error { return dao.InsertTestSession(ctx, registration) },
		"bot insertion":             func() error { _, e := dao.InsertBotSession(ctx, registration); return e },
		"session location":          func() error { _, e := dao.SessionLocation(ctx, id); return e },
		"grant lookup":              func() error { _, e := dao.SessionLocationByGrant(ctx, []byte("x")); return e },
		"current task session":      func() error { _, e := dao.CurrentTaskSession(ctx, id, other, id); return e },
		"grant update":              func() error { return dao.SetSessionGrant(ctx, store.SessionGrant{SessionID: id}) },
		"generation stop":           func() error { return dao.SetSessionGenerationStop(ctx, id, []byte(`{}`)) },
		"test stop":                 func() error { return dao.SetTestSessionStop(ctx, id, []byte(`{}`)) },
		"connect":                   func() error { return dao.ConnectSession(ctx, id, other, now, &now) },
		"touch":                     func() error { return dao.TouchSession(ctx, id, now) },
		"disconnect":                func() error { return dao.DisconnectSession(ctx, id) },
		"session lookup":            func() error { _, e := dao.LockSession(ctx, id); return e },
		"session save":              func() error { return dao.SaveSession(ctx, store.SessionRecord{}) },
		"session bot":               func() error { _, e := dao.SessionBotID(ctx, id); return e },
		"bot session locks":         func() error { _, e := dao.LockBotSessions(ctx, id); return e },
		"bot revocation":            func() error { return dao.RevokeBotSessions(ctx, id) },
		"bot stop proof":            func() error { _, e := dao.LockBotSessionStop(ctx, id, other, id); return e },
		"bot cleanup":               func() error { return dao.DeleteBotSession(ctx, id, other) },
		"bot redact":                func() error { return dao.RedactDeletedBot(ctx, id) },
		"operation read":            func() error { _, e := dao.SessionOperation(ctx, id, other); return e },
		"operation insert":          func() error { return dao.InsertSessionOperation(ctx, op) },
		"operation receipt":         func() error { return dao.SetSessionOperationReceipt(ctx, sp.Operation{}) },
		"operation epoch":           func() error { return dao.SetSessionOperationEpoch(ctx, id, other, 1) },
		"first input":               func() error { _, e := dao.HasOtherFirstInput(ctx, id, other); return e },
		"interaction":               func() error { _, e := dao.HasInteractionResponse(ctx, id, other, id); return e },
		"pending count":             func() error { _, e := dao.PendingSessionOperationCount(ctx, id); return e },
		"accepted list":             func() error { _, e := dao.AcceptedSessionOperations(ctx, id); return e },
		"stop list":                 func() error { _, e := dao.StoppingTestOperations(ctx, id); return e },
		"unreconciled list":         func() error { _, e := dao.UnreconciledSessionOperations(ctx, id, 1); return e },
		"unreconciled count":        func() error { _, e := dao.UnreconciledSessionOperationCount(ctx, id, 1); return e },
		"archive task":              func() error { _, _, e := dao.LockArchiveTask(ctx, id, other); return e },
		"archive read":              func() error { _, _, e := dao.SessionArchive(ctx, id); return e },
		"archive state":             func() error { return dao.SetSessionArchiveState(ctx, id, "pending", nil) },
		"archive ready":             func() error { return dao.SetSessionArchiveReady(ctx, id, strings.Repeat("a", 64), 1, "path") },
		"test list":                 func() error { _, e := dao.ListTestSessions(ctx, id, now, 1, false, now, nil, ""); return e },
		"terminal lock":             func() error { _, e := dao.LockTerminal(ctx, id); return e },
		"terminal save":             func() error { return dao.SaveTerminal(ctx, id, []byte(`{}`), &now, other) },
		"terminal registration":     func() error { _, e := dao.FindTerminalRegistration(ctx, id, other, id, other, id); return e },
		"terminal insert":           func() error { return dao.InsertTerminal(ctx, store.TerminalRegistration{}) },
		"evidence insert":           func() error { return dao.InsertRecordingEvidence(ctx, id, 1, other, 1, strings.Repeat("a", 64)) },
		"terminal operation":        func() error { _, e := dao.TerminalOperation(ctx, id, other); return e },
		"terminal operation insert": func() error { return dao.InsertTerminalOperation(ctx, terminal) },
		"terminal result":           func() error { return dao.SetTerminalOperationResult(ctx, id, v2.OperationResult{}) },
		"terminal invalidate":       func() error { return dao.InvalidateTerminalOperations(ctx, id) },
		"terminal expiry":           func() error { return dao.ExpireTerminalOperations(ctx, id, now) },
		"terminal queued":           func() error { _, e := dao.QueuedTerminalOperation(ctx, id); return e },
		"terminal viewer":           func() error { _, e := dao.TerminalViewerOperationPending(ctx, id, other, id); return e },
		"terminal archive":          func() error { _, _, _, e := dao.TerminalArchive(ctx, id); return e },
		"terminal receipt":          func() error { return dao.SaveTerminalReceipt(ctx, id, v2.Receipt{}, nil) },
		"terminal archive status":   func() error { return dao.SaveTerminalArchiveStatus(ctx, id, v2.ArchiveStatus{}) },
		"terminal current":          func() error { _, e := dao.CurrentTerminalSession(ctx, id, other, id); return e },
		"terminal history":          func() error { _, e := dao.TerminalHistory(ctx, id, other, nil, nil, 1); return e },
		"terminal evidence":         func() error { _, _, e := dao.TerminalRecordingEvidence(ctx, id, 1, other); return e },
		"terminal admission":        func() error { _, e := dao.TerminalAutomationAllowed(ctx, id); return e },
		"terminal pending":          func() error { _, e := dao.TerminalInputPending(ctx, id); return e },
	} {
		t.Run(name, func(t *testing.T) {
			if err := run(); err == nil {
				t.Fatal("closed transaction reported success")
			}
		})
	}
	db.Close()
	completion, err := db.WriteSession(ctx, func(store.SessionScope) error { t.Fatal("closed pool invoked callback"); return nil })
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("closed pool: %+v %v", completion, err)
	}
}

func TestSessionDAOTaskArchiveLocksAndCorruptProperties(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','true')`, task.ID)
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		current, err := scope.SessionDAO().LockTask(ctx, project.ID, task.ID)
		if err != nil || current.Status != "in_progress" {
			t.Fatalf("task: %+v %v", current, err)
		}
		current, deleted, err := scope.SessionDAO().LockArchiveTask(ctx, project.ID, task.ID)
		if err != nil || deleted || current.Status != "in_progress" {
			t.Fatalf("archive task: %+v %v %v", current, deleted, err)
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, task.ID)
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		_, err := scope.SessionDAO().LockTask(ctx, project.ID, task.ID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted task remained active: %v", err)
		}
		_, deleted, err := scope.SessionDAO().LockArchiveTask(ctx, project.ID, task.ID)
		if err != nil || !deleted {
			t.Fatalf("deleted archive task: %v %v", deleted, err)
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE task_properties SET value='{' WHERE task_id=$1 AND name='paused'`, task.ID)
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		_, _, err := scope.SessionDAO().LockArchiveTask(ctx, project.ID, task.ID)
		if err == nil {
			t.Fatal("corrupt task property accepted")
		}
		return nil
	})
}
