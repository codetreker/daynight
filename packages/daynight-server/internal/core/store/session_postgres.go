package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/jackc/pgx/v5"
)

type sessionTx struct{ tx pgx.Tx }

func (s *Store) WriteSession(ctx context.Context, operation func(SessionScope) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, queryError("begin session", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(&sessionTx{tx: tx}) })
	return teamCompletion("write session", err)
}

func (tx *sessionTx) SessionDAO() SessionDAO { return tx }
func (tx *sessionTx) BotDAO() BotWriteDAO    { return &botTx{tx: tx.tx} }

func (tx *sessionTx) LockCredential(ctx context.Context, principal model.Principal, now time.Time) error {
	table := "sessions"
	predicate := "expires_at>$3"
	if principal.Kind == model.PATCredential {
		table = "personal_access_tokens"
		predicate = "(expires_at IS NULL OR expires_at>$3)"
	} else if principal.Kind != model.SessionCredential {
		return model.ErrNotFound
	}
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM `+table+` WHERE id=$1 AND user_id=$2 AND `+predicate+` FOR SHARE`, principal.CredentialID, principal.UserID, now).Scan(&id)
	if err != nil {
		return queryError("lock session credential", err)
	}
	return nil
}

func (tx *sessionTx) ProjectAccess(ctx context.Context, userID, projectID string) (model.ProjectAccess, error) {
	return ReadProjectAccess(ctx, tx.tx, userID, projectID)
}

func (tx *sessionTx) LockTask(ctx context.Context, project, id string) (SessionTask, error) {
	var task SessionTask
	if err := tx.tx.QueryRow(ctx, `SELECT status FROM tasks WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`, project, id).Scan(&task.Status); err != nil {
		return SessionTask{}, queryError("lock session task", err)
	}
	return tx.sessionTaskProperties(ctx, id, task)
}

func (tx *sessionTx) sessionTaskProperties(ctx context.Context, id string, task SessionTask) (SessionTask, error) {
	rows, err := tx.tx.Query(ctx, `SELECT name,value FROM task_properties WHERE task_id=$1 ORDER BY name`, id)
	if err != nil {
		return SessionTask{}, queryError("read session task properties", err)
	}
	defer rows.Close()
	properties := model.TaskProperties{}
	for rows.Next() {
		var name, value string
		if err := rows.Scan(&name, &value); err != nil {
			return SessionTask{}, queryError("read session task properties", err)
		}
		properties[name], err = taskproperties.NormalizeValue(name, json.RawMessage(value))
		if err != nil {
			return SessionTask{}, err
		}
	}
	if err := rows.Err(); err != nil {
		return SessionTask{}, queryError("read session task properties", err)
	}
	task.Worker, err = taskproperties.Worker(properties)
	if err != nil {
		return task, err
	}
	task.StartupReport, err = taskproperties.SessionStartup(properties)
	return task, err
}

func (tx *sessionTx) SessionBotID(ctx context.Context, id string) (*string, error) {
	var botID *string
	if err := tx.tx.QueryRow(ctx, `SELECT bot_id::text FROM task_sessions WHERE id=$1 AND backend='web'`, id).Scan(&botID); err != nil {
		return nil, queryError("read session bot", err)
	}
	return botID, nil
}

func (tx *sessionTx) LockSession(ctx context.Context, id string) (SessionRecord, error) {
	var r SessionRecord
	var raw []byte
	var parent, kind, connectionParent *string
	err := tx.tx.QueryRow(ctx, `SELECT bot_id::text,server_instance::text,snapshot,owner_user_id::text,parent_credential_id::text,registration,source_epoch::text,source_epochs::text[],last_source_seq,last_operation_seq,grant_hash,grant_expires_at,connection_expires_at,last_seen,draining_until,grant_kind,grant_consumed,stop_proof,connection_parent_credential_id::text,draining_timeline_seq,EXISTS(SELECT 1 FROM session_operations WHERE session_id=task_sessions.id AND command->>'kind'='send_message' AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted','confirmed','unknown')) FROM task_sessions WHERE id=$1 AND backend='web' FOR UPDATE`, id).Scan(&r.BotID, &r.ServerInstance, &raw, &r.Owner, &parent, &r.Registration, &r.SourceEpoch, &r.SourceEpochs, &r.SourceSeq, &r.OperationSeq, &r.GrantHash, &r.GrantExpiry, &r.ConnectionExpiry, &r.LastSeen, &r.DrainUntil, &kind, &r.Consumed, &r.StopProof, &connectionParent, &r.DrainTimelineSeq, &r.FirstInputBlocked)
	if err != nil {
		return SessionRecord{}, queryError("lock session", err)
	}
	if parent != nil {
		r.Parent = *parent
	}
	if connectionParent != nil {
		r.ConnectionParent = *connectionParent
	}
	if kind != nil {
		r.GrantKind = *kind
	}
	if err := json.Unmarshal(raw, &r.Snapshot); err != nil {
		return SessionRecord{}, queryError("decode session", err)
	}
	return r, nil
}

func (tx *sessionTx) SaveSession(ctx context.Context, r SessionRecord) error {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return queryError("encode session", err)
	}
	_, err = tx.tx.Exec(ctx, `UPDATE task_sessions SET snapshot=$2,source_epoch=$3,source_epochs=$4,last_source_seq=$5,last_operation_seq=$6 WHERE id=$1`, r.Snapshot.SessionID, raw, r.SourceEpoch, r.SourceEpochs, r.SourceSeq, r.OperationSeq)
	if err != nil {
		return queryError("save session", err)
	}
	return nil
}

func (tx *sessionTx) LockTaskRegistration(ctx context.Context, project, taskID string) error {
	_, err := tx.tx.Exec(ctx, `SELECT id FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE`, project, taskID)
	if err != nil {
		return queryError("lock task registration", err)
	}
	return nil
}

func (tx *sessionTx) LockTestOwner(ctx context.Context, userID string) error {
	_, err := tx.tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID)
	if err != nil {
		return queryError("lock test owner", err)
	}
	return nil
}

func (tx *sessionTx) FindTaskRegistration(ctx context.Context, project, registration, taskID, claim string) (string, error) {
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND (registration_id=$2 OR (task_id=$3 AND claim_id=$4))`, project, registration, taskID, claim).Scan(&id)
	if err != nil {
		return "", queryError("find task session registration", err)
	}
	return id, nil
}

func (tx *sessionTx) FindTestRegistration(ctx context.Context, owner, registration, execution string) (string, *string, error) {
	var id string
	var botID *string
	err := tx.tx.QueryRow(ctx, `SELECT id::text,bot_id::text FROM task_sessions WHERE scope='test' AND owner_user_id=$1 AND (registration_id=$2 OR test_execution_id=$3)`, owner, registration, execution).Scan(&id, &botID)
	if err != nil {
		return "", nil, queryError("find test session registration", err)
	}
	return id, botID, nil
}

func (tx *sessionTx) InsertTaskSession(ctx context.Context, r SessionRegistration) error {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return queryError("encode session registration", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, r.Location.SessionID, r.Location.ProjectID, r.Location.TaskID, r.ClaimID, r.OwnerID, r.RegistrationID, r.Registration, raw)
	if err != nil {
		return queryError("insert task session", err)
	}
	return nil
}

func (tx *sessionTx) InsertTestSession(ctx context.Context, r SessionRegistration) error {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return queryError("encode session registration", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id) VALUES($1,'test',$2,$3,$4,$5,$6,$7)`, r.Location.SessionID, r.TestExecutionID, r.OwnerID, r.RegistrationID, r.Registration, raw, r.ParentCredentialID)
	if err != nil {
		return queryError("insert test session", err)
	}
	return nil
}

func (tx *sessionTx) SessionLocation(ctx context.Context, id string) (SessionLocation, error) {
	location := SessionLocation{SessionID: id}
	err := tx.tx.QueryRow(ctx, `SELECT COALESCE(project_id::text,''),COALESCE(task_id::text,'') FROM task_sessions WHERE id=$1`, id).Scan(&location.ProjectID, &location.TaskID)
	if err != nil {
		return SessionLocation{}, queryError("read session scope", err)
	}
	return location, nil
}

func (tx *sessionTx) SessionLocationByGrant(ctx context.Context, hash []byte) (SessionLocation, error) {
	var location SessionLocation
	err := tx.tx.QueryRow(ctx, `SELECT COALESCE(project_id::text,''),COALESCE(task_id::text,''),id::text FROM task_sessions WHERE grant_hash=$1`, hash).Scan(&location.ProjectID, &location.TaskID, &location.SessionID)
	if err != nil {
		return SessionLocation{}, queryError("read session grant", err)
	}
	return location, nil
}

func (tx *sessionTx) CurrentTaskSession(ctx context.Context, project, taskID, claim string) (string, error) {
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND claim_id=$3`, project, taskID, claim).Scan(&id)
	if err != nil {
		return "", queryError("read current task session", err)
	}
	return id, nil
}

func (tx *sessionTx) SetSessionGrant(ctx context.Context, g SessionGrant) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET grant_hash=$2,grant_expires_at=$3,grant_kind=$4,grant_consumed=false,parent_credential_id=$5 WHERE id=$1`, g.SessionID, g.Hash, g.ExpiresAt, g.Kind, g.ParentCredentialID)
	if err != nil {
		return queryError("set session grant", err)
	}
	return nil
}

func (tx *sessionTx) SetSessionGenerationStop(ctx context.Context, id string, stopProof []byte) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET stop_proof=$2,connection_expires_at=NULL WHERE id=$1`, id, stopProof)
	if err != nil {
		return queryError("set session generation stop", err)
	}
	return nil
}

func (tx *sessionTx) SetTestSessionStop(ctx context.Context, id string, stopProof []byte) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET stop_proof=$2,grant_hash=NULL,grant_expires_at=NULL,connection_expires_at=NULL WHERE id=$1`, id, stopProof)
	if err != nil {
		return queryError("stop test session", err)
	}
	return nil
}

func (tx *sessionTx) ConnectSession(ctx context.Context, id, instance string, now time.Time, expiry *time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET grant_consumed=true,server_instance=$2,connected_at=$3,last_seen=$3,connection_expires_at=$4,connection_parent_credential_id=parent_credential_id WHERE id=$1`, id, instance, now, expiry)
	if err != nil {
		return queryError("connect session", err)
	}
	return nil
}

func (tx *sessionTx) TouchSession(ctx context.Context, id string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET last_seen=$2 WHERE id=$1`, id, now)
	if err != nil {
		return queryError("touch session", err)
	}
	return nil
}

func (tx *sessionTx) DisconnectSession(ctx context.Context, id string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET connection_expires_at=NULL WHERE id=$1`, id)
	if err != nil {
		return queryError("disconnect session", err)
	}
	return nil
}

func (tx *sessionTx) LockBotSessions(ctx context.Context, botID string) ([]BotSession, error) {
	rows, err := tx.tx.Query(ctx, `SELECT id::text,owner_user_id::text,scope,backend FROM task_sessions WHERE bot_id=$1 ORDER BY id FOR UPDATE`, botID)
	if err != nil {
		return nil, queryError("lock bot sessions", err)
	}
	defer rows.Close()
	var sessions []BotSession
	for rows.Next() {
		var session BotSession
		if err := rows.Scan(&session.ID, &session.Owner, &session.Scope, &session.Backend); err != nil {
			return nil, queryError("read bot sessions", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read bot sessions", err)
	}
	return sessions, nil
}

func (tx *sessionTx) RevokeBotSessions(ctx context.Context, botID string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET grant_hash=NULL,grant_expires_at=NULL,connection_expires_at=NULL WHERE bot_id=$1`, botID)
	if err != nil {
		return queryError("revoke bot sessions", err)
	}
	return nil
}

func (tx *sessionTx) LockBotSessionStop(ctx context.Context, id, botID, owner string) (BotSessionStop, error) {
	var result BotSessionStop
	var raw []byte
	err := tx.tx.QueryRow(ctx, `SELECT snapshot,grant_consumed,source_epoch::text FROM task_sessions WHERE id=$1 AND bot_id=$2 AND owner_user_id=$3 AND scope='test' AND backend='web' FOR UPDATE`, id, botID, owner).Scan(&raw, &result.Consumed, &result.SourceEpoch)
	if err != nil {
		return BotSessionStop{}, queryError("lock bot session stop", err)
	}
	if err := json.Unmarshal(raw, &result.Snapshot); err != nil {
		return BotSessionStop{}, queryError("decode bot session stop", err)
	}
	return result, nil
}

func (tx *sessionTx) DeleteBotSession(ctx context.Context, id, botID string) error {
	// These tables do not cascade on Session removal, including archive and recording metadata.
	for _, table := range []string{"session_events", "session_timeline", "session_operations", "session_resources", "session_archives", "session_recording_evidence"} {
		if _, err := tx.tx.Exec(ctx, `DELETE FROM `+table+` WHERE session_id=$1`, id); err != nil {
			return queryError("delete bot session children", err)
		}
	}
	_, err := tx.tx.Exec(ctx, `DELETE FROM task_sessions WHERE id=$1 AND bot_id=$2`, id, botID)
	if err != nil {
		return queryError("delete bot session", err)
	}
	return nil
}

func (tx *sessionTx) RedactDeletedBot(ctx context.Context, botID string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE bots SET session_id=NULL,role_configuration=NULL,name='Deleted',requested_overrides='{}',resolved_configuration='{}',startup_result='{"state":"failed","code":"deleted"}' WHERE id=$1`, botID)
	if err != nil {
		return queryError("redact deleted bot", err)
	}
	return nil
}

func (tx *sessionTx) SessionOperation(ctx context.Context, session, id string) (SessionOperation, error) {
	o := SessionOperation{SessionID: session, OperationID: id}
	var command, receipt []byte
	var kind string
	err := tx.tx.QueryRow(ctx, `SELECT command,receipt,actor_user_id::text,credential_id::text,credential_kind,body_hash,dispatch_epoch,operation_seq,deadline FROM session_operations WHERE session_id=$1 AND operation_id=$2`, session, id).Scan(&command, &receipt, &o.Actor.UserID, &o.Actor.CredentialID, &kind, &o.Hash, &o.Epoch, &o.Seq, &o.Deadline)
	if err != nil {
		return SessionOperation{}, queryError("read session operation", err)
	}
	o.Actor.Kind = model.CredentialKind(kind)
	if err = json.Unmarshal(command, &o.Command); err != nil {
		return SessionOperation{}, queryError("decode session command", err)
	}
	if err = json.Unmarshal(receipt, &o.Receipt); err != nil {
		return SessionOperation{}, queryError("decode session receipt", err)
	}
	return o, nil
}

func (tx *sessionTx) InsertSessionOperation(ctx context.Context, o SessionOperation) error {
	command, err := json.Marshal(o.Command)
	if err != nil {
		return queryError("encode session command", err)
	}
	receipt, err := json.Marshal(o.Receipt)
	if err != nil {
		return queryError("encode session receipt", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, o.SessionID, o.OperationID, o.Seq, o.Hash, command, o.Actor.UserID, o.Actor.CredentialID, string(o.Actor.Kind), receipt)
	if err != nil {
		return queryError("insert session operation", err)
	}
	return nil
}

func (tx *sessionTx) SetSessionOperationReceipt(ctx context.Context, o sp.Operation) error {
	raw, err := json.Marshal(o)
	if err != nil {
		return queryError("encode session receipt", err)
	}
	_, err = tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=$3 WHERE session_id=$1 AND operation_id=$2`, o.SessionID, o.OperationID, raw)
	if err != nil {
		return queryError("set session receipt", err)
	}
	return nil
}

func (tx *sessionTx) SetSessionOperationEpoch(ctx context.Context, session, id string, epoch int64) error {
	_, err := tx.tx.Exec(ctx, `UPDATE session_operations SET dispatch_epoch=$3 WHERE session_id=$1 AND operation_id=$2`, session, id, epoch)
	if err != nil {
		return queryError("set session operation epoch", err)
	}
	return nil
}

func (tx *sessionTx) HasOtherFirstInput(ctx context.Context, session, id string) (bool, error) {
	var exists bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND operation_id<>$2 AND command->>'kind'='send_message' AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted','confirmed','unknown'))`, session, id).Scan(&exists)
	if err != nil {
		return false, queryError("read session first input", err)
	}
	return exists, nil
}

func (tx *sessionTx) HasInteractionResponse(ctx context.Context, session, id, interaction string) (bool, error) {
	var exists bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND operation_id<>$2 AND command->>'kind'='interaction_response' AND command->'payload'->>'interactionId'=$3 AND receipt->>'state' NOT IN ('rejected','expired','failed'))`, session, id, interaction).Scan(&exists)
	if err != nil {
		return false, queryError("read session interaction response", err)
	}
	return exists, nil
}

func (tx *sessionTx) PendingSessionOperationCount(ctx context.Context, session string) (int, error) {
	var count int
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted')`, session).Scan(&count)
	if err != nil {
		return 0, queryError("count pending session operations", err)
	}
	return count, nil
}

func (tx *sessionTx) AcceptedSessionOperations(ctx context.Context, session string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state'='accepted' ORDER BY operation_seq LIMIT 100`, session)
	if err != nil {
		return nil, queryError("read accepted session operations", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, queryError("read accepted session operations", err)
	}
	return ids, nil
}

func (tx *sessionTx) StoppingTestOperations(ctx context.Context, session string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('accepted','offered','dispatching')`, session)
	if err != nil {
		return nil, queryError("read stopping test operations", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, queryError("read stopping test operations", err)
	}
	return ids, nil
}

func (tx *sessionTx) UnreconciledSessionOperations(ctx context.Context, session string, epoch int64) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND dispatch_epoch IS DISTINCT FROM $2 AND receipt->>'state' IN ('offered','dispatching') ORDER BY operation_seq LIMIT 100`, session, epoch)
	if err != nil {
		return nil, queryError("read unreconciled session operations", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, queryError("read unreconciled session operations", err)
	}
	return ids, nil
}

func (tx *sessionTx) UnreconciledSessionOperationCount(ctx context.Context, session string, epoch int64) (int, error) {
	var count int
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1 AND dispatch_epoch IS DISTINCT FROM $2 AND receipt->>'state' IN ('offered','dispatching')`, session, epoch).Scan(&count)
	if err != nil {
		return 0, queryError("count unreconciled session operations", err)
	}
	return count, nil
}

func (tx *sessionTx) LockArchiveTask(ctx context.Context, project, id string) (SessionTask, bool, error) {
	var task SessionTask
	var deleted bool
	if err := tx.tx.QueryRow(ctx, `SELECT status,deleted_at IS NOT NULL FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE`, project, id).Scan(&task.Status, &deleted); err != nil {
		return SessionTask{}, false, queryError("lock archive task", err)
	}
	task, err := tx.sessionTaskProperties(ctx, id, task)
	return task, deleted, err
}

func (tx *sessionTx) SessionArchive(ctx context.Context, id string) (sp.ArchiveStatus, string, error) {
	status := sp.ArchiveStatus{State: "unavailable"}
	var path *string
	err := tx.tx.QueryRow(ctx, `SELECT state,sha256,byte_length::text,error_code,object_path FROM session_archives WHERE session_id=$1`, id).Scan(&status.State, &status.SHA256, &status.ByteLength, &status.ErrorCode, &path)
	if errors.Is(err, pgx.ErrNoRows) {
		return sp.ArchiveStatus{State: "unavailable"}, "", nil
	}
	if err != nil {
		return sp.ArchiveStatus{}, "", queryError("read session archive", err)
	}
	if path != nil {
		return status, *path, nil
	}
	return status, "", nil
}

func (tx *sessionTx) SetSessionArchiveState(ctx context.Context, id, state string, code *string) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,error_code) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,updated_at=now()`, id, state, code)
	if err != nil {
		return queryError("set session archive state", err)
	}
	return nil
}

func (tx *sessionTx) SetSessionArchiveReady(ctx context.Context, id, digest string, size int, path string) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path) VALUES($1,'ready',$2,$3,$4) ON CONFLICT(session_id) DO UPDATE SET state='ready',sha256=excluded.sha256,byte_length=excluded.byte_length,object_path=excluded.object_path,error_code=NULL,updated_at=now()`, id, digest, size, path)
	if err != nil {
		return queryError("set session archive ready", err)
	}
	return nil
}

func (tx *sessionTx) ListTestSessions(ctx context.Context, owner string, now time.Time, limit int, online bool, heartbeatFloor time.Time, after *time.Time, afterID string) ([]TestSessionListItem, error) {
	query := `SELECT ts.snapshot,ts.created_at,recent.updated_at,ts.last_seen,ts.draining_until
 FROM task_sessions ts
 CROSS JOIN LATERAL (SELECT GREATEST(ts.created_at,COALESCE(ts.last_seen,ts.created_at)) AS updated_at) recent
 WHERE ts.scope='test' AND ts.bot_id IS NULL AND ts.owner_user_id=$1
 AND (ts.parent_credential_id IS NULL OR EXISTS (SELECT 1 FROM personal_access_tokens pat WHERE pat.id=ts.parent_credential_id AND pat.user_id=$1 AND (pat.expires_at IS NULL OR pat.expires_at>$2) FOR SHARE))
 AND (NOT $4::boolean OR (
 ts.snapshot->>'lifecycle'='active' AND ts.last_seen >= $5::timestamptz AND ts.connection_expires_at>$2
 AND (ts.draining_until IS NULL OR ts.draining_until>$2)
 AND EXISTS (SELECT 1 FROM personal_access_tokens pat WHERE pat.id=ts.connection_parent_credential_id AND pat.user_id=$1 AND (pat.expires_at IS NULL OR pat.expires_at>$2) FOR SHARE)))`
	args := []any{owner, now, limit + 1, online, heartbeatFloor}
	if after != nil {
		query += ` AND (recent.updated_at,ts.id)<($6::timestamptz,$7::uuid)`
		args = append(args, *after, afterID)
	}
	query += ` ORDER BY recent.updated_at DESC,ts.id DESC LIMIT $3`
	rows, err := tx.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, queryError("list test sessions", err)
	}
	defer rows.Close()
	var result []TestSessionListItem
	for rows.Next() {
		var item TestSessionListItem
		var raw []byte
		if err := rows.Scan(&raw, &item.CreatedAt, &item.UpdatedAt, &item.LastSeen, &item.DrainUntil); err != nil {
			return nil, queryError("read test sessions", err)
		}
		if err := json.Unmarshal(raw, &item.Snapshot); err != nil {
			return nil, queryError("decode test session", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read test sessions", err)
	}
	return result, nil
}

func (tx *sessionTx) LockTerminal(ctx context.Context, id string) ([]byte, error) {
	var raw []byte
	if err := tx.tx.QueryRow(ctx, `SELECT terminal_state FROM task_sessions WHERE id=$1 AND backend='herdr' FOR UPDATE`, id).Scan(&raw); err != nil {
		return nil, queryError("lock terminal", err)
	}
	return raw, nil
}

func (tx *sessionTx) SaveTerminal(ctx context.Context, id string, raw []byte, seen *time.Time, instance string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET terminal_state=$2,last_seen=$3,server_instance=$4 WHERE id=$1 AND backend='herdr'`, id, raw, seen, instance)
	if err != nil {
		return queryError("save terminal", err)
	}
	return nil
}

func (tx *sessionTx) FindTerminalRegistration(ctx context.Context, id, project, registration, taskID, claim string) (string, error) {
	var found string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE id=$1 OR (project_id=$2 AND (registration_id=$3 OR (task_id=$4 AND claim_id=$5)))`, id, project, registration, taskID, claim).Scan(&found)
	if err != nil {
		return "", queryError("find terminal registration", err)
	}
	return found, nil
}

func (tx *sessionTx) InsertTerminal(ctx context.Context, r TerminalRegistration) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state,last_seen,server_instance) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'herdr',$8,$9,$10)`, r.SessionID, r.ProjectID, r.TaskID, r.ClaimID, r.OwnerID, r.RegistrationID, r.Registration, r.State, r.LastSeen, r.ServerInstance)
	if err != nil {
		return queryError("insert terminal", err)
	}
	return nil
}

func (tx *sessionTx) InsertRecordingEvidence(ctx context.Context, id string, generation int64, evidenceID string, revision int64, hash string) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_recording_evidence(session_id,execution_generation,evidence_id,revision,body_hash) VALUES($1,$2,$3,$4,$5)`, id, generation, evidenceID, revision, hash)
	if err != nil {
		return queryError("insert recording evidence", err)
	}
	return nil
}

func (tx *sessionTx) TerminalOperation(ctx context.Context, id, operationID string) (TerminalOperation, error) {
	out := TerminalOperation{SessionID: id, OperationID: operationID}
	var result []byte
	var kind string
	err := tx.tx.QueryRow(ctx, `SELECT command,receipt,actor_user_id::text,credential_id::text,credential_kind,body_hash,dispatch_epoch,deadline FROM session_operations WHERE session_id=$1 AND operation_id=$2`, id, operationID).Scan(&out.Command, &result, &out.Actor.UserID, &out.Actor.CredentialID, &kind, &out.Hash, &out.Epoch, &out.Deadline)
	if err != nil {
		return TerminalOperation{}, queryError("read terminal operation", err)
	}
	out.Actor.Kind = model.CredentialKind(kind)
	if err := json.Unmarshal(result, &out.Result); err != nil {
		return TerminalOperation{}, queryError("decode terminal result", err)
	}
	return out, nil
}

func (tx *sessionTx) InsertTerminalOperation(ctx context.Context, o TerminalOperation) error {
	raw, err := json.Marshal(o.Result)
	if err != nil {
		return queryError("encode terminal result", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, o.SessionID, o.OperationID, o.Seq, o.Hash, o.Command, o.Actor.UserID, o.Actor.CredentialID, string(o.Actor.Kind), raw, o.Deadline)
	if err != nil {
		return queryError("insert terminal operation", err)
	}
	return nil
}

func (tx *sessionTx) SetTerminalOperationResult(ctx context.Context, id string, result v2.OperationResult) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return queryError("encode terminal result", err)
	}
	_, err = tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=$3 WHERE session_id=$1 AND operation_id=$2`, id, result.OperationID, raw)
	if err != nil {
		return queryError("set terminal result", err)
	}
	return nil
}

func (tx *sessionTx) InvalidateTerminalOperations(ctx context.Context, id string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=jsonb_build_object('operationId',operation_id::text,'state',CASE WHEN receipt->>'state'='queued' THEN 'rejected' ELSE 'unknown' END,'errorCode',CASE WHEN receipt->>'state'='queued' THEN 'stale_fence' ELSE 'input_unknown' END) WHERE session_id=$1 AND receipt->>'state' IN ('queued','dispatching')`, id)
	if err != nil {
		return queryError("invalidate terminal operations", err)
	}
	return nil
}

func (tx *sessionTx) ExpireTerminalOperations(ctx context.Context, id string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=jsonb_build_object('operationId',operation_id::text,'state',CASE WHEN receipt->>'state'='queued' THEN 'rejected' ELSE 'unknown' END,'errorCode',CASE WHEN receipt->>'state'='queued' THEN 'input_busy' ELSE 'input_unknown' END) WHERE session_id=$1 AND deadline<=$2 AND receipt->>'state' IN ('queued','dispatching')`, id, now)
	if err != nil {
		return queryError("expire terminal operations", err)
	}
	return nil
}

func (tx *sessionTx) QueuedTerminalOperation(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state'='queued' ORDER BY operation_seq LIMIT 1`, id)
	if err != nil {
		return nil, queryError("read queued terminal operation", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, queryError("read queued terminal operation", err)
	}
	return ids, nil
}

func (tx *sessionTx) TerminalViewerOperationPending(ctx context.Context, id, user, client string) (bool, error) {
	var pending bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND actor_user_id=$2 AND command->'request'->>'browserClientId'=$3 AND receipt->>'state' IN ('queued','dispatching'))`, id, user, client).Scan(&pending)
	if err != nil {
		return false, queryError("read terminal viewer operation", err)
	}
	return pending, nil
}

func (tx *sessionTx) InsertBotSession(ctx context.Context, r SessionRegistration) (bool, error) {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return false, queryError("encode bot session", err)
	}
	tag, err := tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,bot_id) VALUES($1,'test',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, r.Location.SessionID, r.TestExecutionID, r.OwnerID, r.RegistrationID, r.Registration, raw, r.ParentCredentialID, r.BotID)
	if err != nil {
		return false, queryError("insert bot session", err)
	}
	return tag.RowsAffected() == 1, nil
}
