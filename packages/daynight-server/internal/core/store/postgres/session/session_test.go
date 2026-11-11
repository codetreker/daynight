package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestSessionStore(t *testing.T) {
	suite := newSessionStoreSuite(t)
	suite.run(t, "SessionProjectAccessUsesCallerTransaction", testSessionProjectAccessUsesCallerTransaction)
	suite.run(t, "SessionProjectAccessDoesNotHoldGrantUntilCommit", testSessionProjectAccessDoesNotHoldGrantUntilCommit)
	suite.run(t, "InheritedSessionAccessDoesNotHoldOwnershipOrTeamSources", testInheritedSessionAccessDoesNotHoldOwnershipOrTeamSources)
	suite.run(t, "SessionDAORegistrationGrantAndList", testSessionDAORegistrationGrantAndList)
	suite.run(t, "SessionDAOLedgerAndArchive", testSessionDAOLedgerAndArchive)
	suite.run(t, "SessionDAOClosedTransactionDoesNotReportSuccess", testSessionDAOClosedTransactionDoesNotReportSuccess)
	suite.run(t, "SessionDAOTaskArchiveLocksAndWorkerDecodeFailure", testSessionDAOTaskArchiveLocksAndWorkerDecodeFailure)
	suite.run(t, "BotSessionCleanupIsTransactional", testBotSessionCleanupIsTransactional)
	suite.run(t, "SessionCredentialKindsAndMissingIdentity", testSessionCredentialKindsAndMissingIdentity)
	suite.run(t, "SessionReadsRejectCorruptPersistedJSON", testSessionReadsRejectCorruptPersistedJSON)
	suite.run(t, "TestSessionListFiltersCredentialAndPaginates", testTestSessionListFiltersCredentialAndPaginates)
	suite.run(t, "SessionListOnlineFiltersBeforePagination", testSessionListOnlineFiltersBeforePagination)
	suite.run(t, "SessionListParentOwnershipAndTiedCursor", testSessionListParentOwnershipAndTiedCursor)
	suite.run(t, "SessionListExcludesBotSessionsBeforePagination", testSessionListExcludesBotSessionsBeforePagination)
	suite.run(t, "TaskOAuthCredentialRechecksGrantAndToken", testTaskOAuthCredentialRechecksGrantAndToken)
	suite.run(t, "SessionOperationRetainsOriginalOAuthActorAfterRevocation", testSessionOperationRetainsOriginalOAuthActorAfterRevocation)
	suite.run(t, "ObservationSnapshotRechecksCredentialsAndMembershipWithoutWrites/pat", func(t *testing.T, db *postgres.Store) {
		testObservationSnapshotRechecksCredentialsAndMembershipWithoutWrites(t, db, model.PATCredential)
	})
	suite.run(t, "ObservationSnapshotRechecksCredentialsAndMembershipWithoutWrites/oauth", func(t *testing.T, db *postgres.Store) {
		testObservationSnapshotRechecksCredentialsAndMembershipWithoutWrites(t, db, model.OAuthCredential)
	})
	suite.run(t, "ObservationReaderSelectsTaskIDsAndHistoricalSession", testObservationReaderSelectsTaskIDsAndHistoricalSession)
	suite.run(t, "ObservationReaderBoundsBatchBeforeQuery", testObservationReaderBoundsBatchBeforeQuery)
	suite.run(t, "ObservationReaderProjectsHerdrWithoutFrames", testObservationReaderProjectsHerdrWithoutFrames)
	suite.run(t, "NativeSessionLedgerDoesNotCreateLegacyContentRows", testNativeSessionLedgerDoesNotCreateLegacyContentRows)
	suite.run(t, "SessionOperationPreservesStoredHashBytes", testSessionOperationPreservesStoredHashBytes)
	suite.run(t, "ProjectSessionStartupAndDrain", testProjectSessionStartupAndDrain)
	suite.run(t, "SessionStartupIdentityMatchesOnlyCurrentBinding", testSessionStartupIdentityMatchesOnlyCurrentBinding)
	suite.run(t, "DrainTaskSessionsPreservesActiveClaim", testDrainTaskSessionsPreservesActiveClaim)
	suite.run(t, "ProjectRetirementBatchesAndRollback", testProjectRetirementBatchesAndRollback)
	suite.run(t, "SessionReaderCurrentProjectBindingsAndNarrowMetadata", testSessionReaderCurrentProjectBindingsAndNarrowMetadata)
	suite.run(t, "SessionReaderPropagatesWorkerDecodeErrors", testSessionReaderPropagatesWorkerDecodeErrors)
	suite.run(t, "SessionReaderPreservesMetadataDecodeErrorsAndIndependentIdentity", testSessionReaderPreservesMetadataDecodeErrorsAndIndependentIdentity)
	suite.run(t, "SessionReaderUsesOneReadOnlyProjectQuery", testSessionReaderUsesOneReadOnlyProjectQuery)
}

func testSessionProjectAccessUsesCallerTransaction(t *testing.T, db *postgres.Store) {
	_, principal, project := prepareMembership(t, db)
	ctx := context.Background()
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, principal.UserID)
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	if _, err = tx.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	access, err := dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if err != nil || access.Role != model.ProjectMemberRole {
		t.Fatal("admission ignored the caller's uncommitted role", access, err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
		t.Fatal(err)
	}
	_, err = dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("uncommitted revocation remained authorized", err)
	}
}

func testSessionProjectAccessDoesNotHoldGrantUntilCommit(t *testing.T, db *postgres.Store) {
	_, principal, project := prepareMembership(t, db)
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, principal.UserID)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	dao := pgsession.New(tx)
	access, err := dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if err != nil || access.Role != model.ProjectAdmin {
		t.Fatal("initial admission failed", access, err)
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
		t.Fatal("Session admission blocked grant revocation", err)
	}
	_, err = dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("committed revocation remained authorized", err)
	}
}

func testInheritedSessionAccessDoesNotHoldOwnershipOrTeamSources(t *testing.T, db *postgres.Store) {
	principal, _, project := prepareMembership(t, db)
	mustQueryExec(t, db, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
	teamID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO teams(id,name) VALUES($1,'Other owner')`, teamID)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	dao := pgsession.New(tx)
	access, err := dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if err != nil || access.Role != model.ProjectAdmin {
		t.Fatal("inherited-only Session admission", access, err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1,updated_at=statement_timestamp() WHERE project_id=$1`, project.ID, teamID); err != nil {
		t.Fatal("ordinary Session admission held an ownership fence", err)
	}
	_, err = dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("ownership revocation remained authorized", err)
	}
}

func testSessionDAORegistrationGrantAndList(t *testing.T, db *postgres.Store) {
	ctx := context.Background()
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
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.LockCredential(ctx, principal, now); err != nil {
			return err
		}
		if err := dao.LockCredential(ctx, pat, now); err != nil {
			return err
		}
		if _, err := dao.LockTaskRegistration(ctx, project.ID, task.ID); err != nil {
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
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
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
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
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
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		_, err := dao.ListTestSessions(ctx, principal.UserID, now, 10, false, now.Add(-time.Minute), nil, "")
		if err == nil {
			t.Fatal("invalid stored test snapshot accepted")
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		_, err := dao.SessionLocationByGrant(ctx, hash)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("stop left grant usable: %v", err)
		}
		if err := dao.LockCredential(ctx, pat, now.Add(2*time.Hour)); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expired credential accepted: %v", err)
		}
		return nil
	})
}

func testSessionDAOClosedTransactionDoesNotReportSuccess(t *testing.T, db *postgres.Store) {
	ctx := context.Background()
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
		"task registration lock":    func() error { _, e := dao.LockTaskRegistration(ctx, id, other); return e },
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
			if err := run(); !errors.Is(err, pgx.ErrTxClosed) {
				t.Fatalf("closed transaction lost its cause: %v", err)
			}
		})
	}
}

func testSessionDAOTaskArchiveLocksAndWorkerDecodeFailure(t *testing.T, db *postgres.Store) {
	ctx := context.Background()
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','true')`, task.ID)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		current, err := dao.LockTask(ctx, project.ID, task.ID)
		if err != nil || current.Status != "in_progress" {
			t.Fatalf("task: %+v %v", current, err)
		}
		current, deleted, err := dao.LockArchiveTask(ctx, project.ID, task.ID)
		if err != nil || deleted || current.Status != "in_progress" {
			t.Fatalf("archive task: %+v %v %v", current, deleted, err)
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, task.ID)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		_, err := dao.LockTask(ctx, project.ID, task.ID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted task remained active: %v", err)
		}
		_, deleted, err := dao.LockArchiveTask(ctx, project.ID, task.ID)
		if err != nil || !deleted {
			t.Fatalf("deleted archive task: %v %v", deleted, err)
		}
		return nil
	})
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{"claimId":1}')`, task.ID)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		_, _, err := dao.LockArchiveTask(ctx, project.ID, task.ID)
		var invalid *json.UnmarshalTypeError
		if !errors.As(err, &invalid) {
			t.Fatalf("worker decode cause lost: %v", err)
		}
		return nil
	})
}

func testSessionCredentialKindsAndMissingIdentity(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC()
	token, grant := uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(token))
	mustQueryExec(t, db, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, token, grant, actor.UserID, hash[:], now, now.Add(time.Minute))
	oauth := model.Principal{Kind: model.OAuthCredential, UserID: actor.UserID, CredentialID: token}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.LockCredential(ctx, oauth, now); err != nil {
			return err
		}
		if err := dao.LockCredential(ctx, model.Principal{Kind: "unknown"}, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unknown credential: %v", err)
		}
		if _, err := dao.ProjectAccess(ctx, actor.UserID, uuid.NewString()); err == nil {
			t.Fatal("missing project access accepted")
		}
		return nil
	})
	mustQueryExec(t, db, `DELETE FROM oauth_access_tokens WHERE id=$1`, token)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.LockCredential(ctx, oauth, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted OAuth token: %v", err)
		}
		return nil
	})
}

func testSessionReadsRejectCorruptPersistedJSON(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	id, operation := uuid.NewString(), uuid.NewString()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: actor.UserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}}, ParentCredentialID: actor.CredentialID}); err != nil {
			return err
		}
		return dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: []byte("operation"), Actor: actor, Command: sp.Command{Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{State: "accepted"}})
	})
	for _, column := range []string{"command", "receipt"} {
		mustQueryExec(t, db, `UPDATE session_operations SET `+column+`='[]' WHERE session_id=$1`, id)
		sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
			if _, err := dao.SessionOperation(ctx, id, operation); err == nil {
				t.Fatalf("corrupt %s accepted", column)
			}
			if column == "receipt" {
				if _, err := dao.TerminalOperation(ctx, id, operation); err == nil {
					t.Fatal("corrupt terminal result accepted")
				}
			}
			return nil
		})
		mustQueryExec(t, db, `UPDATE session_operations SET `+column+`='{}' WHERE session_id=$1`, id)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, id)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if _, err := dao.LockSession(ctx, id); err == nil {
			t.Fatal("corrupt session snapshot accepted")
		}
		err := dao.InsertSessionOperation(ctx, store.SessionOperation{Command: sp.Command{Payload: json.RawMessage(`{`)}})
		if err == nil {
			t.Fatal("invalid command JSON accepted")
		}
		return nil
	})
	final := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO session_archives(session_id,state,schema_version,finalization_id,receipt) VALUES($1,'unavailable',2,$2,'[]')`, id, final)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if _, _, _, err := dao.TerminalArchive(ctx, id); err == nil {
			t.Fatal("corrupt terminal archive receipt accepted")
		}
		return nil
	})
}

func testTestSessionListFiltersCredentialAndPaginates(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	pat := uuid.NewString()
	hash := sha256.Sum256([]byte(pat))
	mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'list',$4,$5)`, pat, actor.UserID, hash[:], now.Add(-time.Hour), now.Add(time.Hour))
	fresh, older, revoked := uuid.NewString(), uuid.NewString(), uuid.NewString()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		for _, id := range []string{fresh, older, revoked} {
			parent := pat
			if id == revoked {
				parent = uuid.NewString()
			}
			if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: actor.UserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}, Lifecycle: "active"}, ParentCredentialID: parent}); err != nil {
				return err
			}
		}
		if err := dao.ConnectSession(ctx, fresh, uuid.NewString(), now, ptrTime(now.Add(time.Hour))); err != nil {
			return err
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE task_sessions SET created_at=$1 WHERE id IN ($2,$3,$4)`, now.Add(-time.Hour), fresh, older, revoked)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		listed, err := dao.ListTestSessions(ctx, actor.UserID, now, 1, false, now.Add(-time.Minute), nil, "")
		if err != nil || len(listed) != 2 || listed[0].Snapshot.SessionID != fresh || listed[1].Snapshot.SessionID != older {
			t.Fatalf("list order and lookahead: %+v %v", listed, err)
		}
		cursor := listed[0].UpdatedAt
		listed, err = dao.ListTestSessions(ctx, actor.UserID, now, 1, false, now.Add(-time.Minute), &cursor, fresh)
		if err != nil || len(listed) != 1 || listed[0].Snapshot.SessionID != older {
			t.Fatalf("list cursor: %+v %v", listed, err)
		}
		listed, err = dao.ListTestSessions(ctx, actor.UserID, now, 10, true, now.Add(-time.Minute), nil, "")
		if err != nil || len(listed) != 1 || listed[0].Snapshot.SessionID != fresh {
			t.Fatalf("online filter: %+v %v", listed, err)
		}
		listed, err = dao.ListTestSessions(ctx, uuid.NewString(), now, 10, false, now.Add(-time.Minute), nil, "")
		if err != nil || len(listed) != 0 {
			t.Fatalf("foreign owner filter: %+v %v", listed, err)
		}
		return nil
	})
}

type sessionListFilterRow struct {
	id, owner, lifecycle, connection string
	created                          time.Time
	parent, connectionParent         *string
	bot                              *string
	seen, expiry, drain              *time.Time
}

func insertSessionListFilterRow(t *testing.T, database *postgres.Store, row sessionListFilterRow) {
	t.Helper()
	execution := uuid.NewString()
	snapshot, err := json.Marshal(sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: row.id, TestExecutionID: execution, ExecutionGeneration: "1"}}, Lifecycle: row.lifecycle, ConnectionState: row.connection})
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id,created_at,parent_credential_id,connection_parent_credential_id,last_seen,connection_expires_at,draining_until,bot_id)
 VALUES($1,$2,$1,'{}',$3,'test',$4,$5,$6,$7,$8,$9,$10,$11)`, row.id, row.owner, snapshot, execution, row.created, row.parent, row.connectionParent, row.seen, row.expiry, row.drain, row.bot)
}

func testSessionListOnlineFiltersBeforePagination(t *testing.T, db *postgres.Store) {
	database := db
	_, actor, _ := testAuthRecords(t, database)
	_, foreign, _ := testAuthRecords(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	floor := now.Add(-30 * time.Second)
	parent, connection, expired, other := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, credential := range []struct {
		id, owner string
		expiry    time.Time
	}{{parent, actor.UserID, now.Add(time.Hour)}, {connection, actor.UserID, now.Add(time.Hour)}, {expired, actor.UserID, now}, {other, foreign.UserID, now.Add(time.Hour)}} {
		hash := sha256.Sum256([]byte(credential.id))
		mustQueryExec(t, database, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'list',$4,$5)`, credential.id, credential.owner, hash[:], now.Add(-time.Hour), credential.expiry)
	}
	row := func(id string) sessionListFilterRow {
		return sessionListFilterRow{id: id, owner: actor.UserID, lifecycle: "active", connection: "connected", created: now.Add(-time.Minute), parent: &parent, connectionParent: &connection, seen: &now, expiry: ptrTime(now.Add(time.Hour))}
	}
	connected, synchronizing := row(queryID(301)), row(queryID(302))
	connected.created, connected.seen = now.Add(-time.Hour), &floor
	synchronizing.created, synchronizing.connection = now.Add(-time.Hour+time.Second), "synchronizing"
	insertSessionListFilterRow(t, database, connected)
	insertSessionListFilterRow(t, database, synchronizing)
	cases := []struct {
		name   string
		change func(*sessionListFilterRow)
	}{
		{"archived", func(r *sessionListFilterRow) { r.lifecycle = "archived" }},
		{"draining", func(r *sessionListFilterRow) { r.lifecycle, r.drain = "draining", ptrTime(now.Add(time.Hour)) }},
		{"missing connection expiry", func(r *sessionListFilterRow) { r.expiry = nil }},
		{"missing heartbeat", func(r *sessionListFilterRow) { r.seen = nil }},
		{"expired heartbeat", func(r *sessionListFilterRow) { r.seen = ptrTime(floor.Add(-time.Microsecond)) }},
		{"expired connection", func(r *sessionListFilterRow) { r.expiry = &now }},
		{"expired drain", func(r *sessionListFilterRow) { r.drain = &now }},
		{"missing connection parent", func(r *sessionListFilterRow) { r.connectionParent = nil }},
		{"expired connection parent", func(r *sessionListFilterRow) { r.connectionParent = &expired }},
		{"foreign connection parent", func(r *sessionListFilterRow) { r.connectionParent = &other }},
	}
	for index, test := range cases {
		r := row(queryID(310 + index))
		test.change(&r)
		insertSessionListFilterRow(t, database, r)
	}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 1, true, floor, nil, "")
		if err != nil || len(items) != 2 || items[0].Snapshot.SessionID != synchronizing.id || items[1].Snapshot.SessionID != connected.id {
			t.Fatalf("online filters, heartbeat edge and lookahead: %+v %v", items, err)
		}
		cursor := items[0].UpdatedAt
		items, err = dao.ListTestSessions(t.Context(), actor.UserID, now, 1, true, floor, &cursor, synchronizing.id)
		if err != nil || len(items) != 1 || items[0].Snapshot.SessionID != connected.id {
			t.Fatalf("filtered cursor tail: %+v %v", items, err)
		}
		return nil
	})
	mustQueryExec(t, database, `DELETE FROM personal_access_tokens WHERE id=$1`, connection)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 100, true, floor, nil, "")
		if err != nil || len(items) != 0 {
			t.Fatalf("revoked connection retained online sessions: %+v %v", items, err)
		}
		items, err = dao.ListTestSessions(t.Context(), actor.UserID, now, 100, false, floor, nil, "")
		if err != nil || len(items) != len(cases)+2 {
			t.Fatalf("connection revocation removed readable history: count=%d error=%v", len(items), err)
		}
		return nil
	})
}

func testSessionListParentOwnershipAndTiedCursor(t *testing.T, db *postgres.Store) {
	database := db
	_, actor, _ := testAuthRecords(t, database)
	_, foreign, _ := testAuthRecords(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	created := now.Add(-time.Hour)
	parent, expired, other := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, credential := range []struct {
		id, owner string
		expiry    time.Time
	}{{parent, actor.UserID, now.Add(time.Hour)}, {expired, actor.UserID, now}, {other, foreign.UserID, now.Add(time.Hour)}} {
		hash := sha256.Sum256([]byte(credential.id))
		mustQueryExec(t, database, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'list',$4,$5)`, credential.id, credential.owner, hash[:], created.Add(-time.Hour), credential.expiry)
	}
	for index, credential := range []*string{&parent, &parent, &expired, &other} {
		insertSessionListFilterRow(t, database, sessionListFilterRow{id: queryID(401 + index), owner: actor.UserID, lifecycle: "archived", created: created, parent: credential})
	}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 1, false, now, nil, "")
		if err != nil || len(items) != 2 || items[0].Snapshot.SessionID != queryID(402) || items[1].Snapshot.SessionID != queryID(401) || !items[0].UpdatedAt.Equal(created) {
			t.Fatalf("parent ownership and tied ID ordering: %+v %v", items, err)
		}
		items, err = dao.ListTestSessions(t.Context(), actor.UserID, now, 1, false, now, &created, queryID(402))
		if err != nil || len(items) != 1 || items[0].Snapshot.SessionID != queryID(401) {
			t.Fatalf("tied cursor skipped or duplicated history: %+v %v", items, err)
		}
		return nil
	})
	mustQueryExec(t, database, `DELETE FROM personal_access_tokens WHERE id=$1`, parent)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 100, false, now, nil, "")
		if err != nil || len(items) != 0 {
			t.Fatalf("revoked registration parent remained discoverable: %+v %v", items, err)
		}
		return nil
	})
}

func testSessionListExcludesBotSessionsBeforePagination(t *testing.T, db *postgres.Store) {
	database := db
	bot, actor := storedBotCandidate(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	parent := uuid.NewString()
	hash := sha256.Sum256([]byte(parent))
	mustQueryExec(t, database, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'list',$4,$5)`, parent, actor.UserID, hash[:], now.Add(-time.Hour), now.Add(time.Hour))
	sessionBotDAOTransaction(t, database, func(_ store.SessionDAO, bots store.BotWriteDAO) error {
		return bots.InsertBot(t.Context(), bot)
	})
	first, middle, last := queryID(602), queryID(601), queryID(600)
	for index, id := range []string{first, middle, last} {
		row := sessionListFilterRow{id: id, owner: actor.UserID, lifecycle: "active", connection: "connected", created: now.Add(-time.Minute), parent: &parent, connectionParent: &parent, seen: ptrTime(now.Add(-time.Duration(index) * time.Second)), expiry: ptrTime(now.Add(time.Hour))}
		if id == middle {
			row.bot = &bot.ID
		}
		insertSessionListFilterRow(t, database, row)
	}
	sessionBotDAOTransaction(t, database, func(_ store.SessionDAO, bots store.BotWriteDAO) error {
		_, err := bots.BindBotSession(t.Context(), bot.ID, 1, middle, model.BotRoleConfiguration{Instructions: "List fixture", Revision: "1", Digest: strings.Repeat("a", 64)})
		return err
	})
	for _, online := range []bool{false, true} {
		t.Run(map[bool]string{false: "all", true: "online"}[online], func(t *testing.T) {
			sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
				items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 1, online, now.Add(-30*time.Second), nil, "")
				if err != nil || len(items) != 2 || items[0].Snapshot.SessionID != first || items[1].Snapshot.SessionID != last {
					t.Fatalf("Bot consumed ordinary inventory lookahead: %+v %v", items, err)
				}
				cursor := items[0].UpdatedAt
				items, err = dao.ListTestSessions(t.Context(), actor.UserID, now, 1, online, now.Add(-30*time.Second), &cursor, first)
				if err != nil || len(items) != 1 || items[0].Snapshot.SessionID != last {
					t.Fatalf("Bot appeared in ordinary inventory cursor tail: %+v %v", items, err)
				}
				return nil
			})
		})
	}
}
