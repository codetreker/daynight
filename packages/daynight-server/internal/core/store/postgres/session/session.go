package session

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pginternal "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// DAO binds Session operations to the caller's transaction.
type DAO struct{ tx pgx.Tx }

// New binds Session operations to tx for the duration of its enclosing scope.
func New(tx pgx.Tx) store.SessionDAO { return &DAO{tx: tx} }

var _ store.SessionDAO = (*DAO)(nil)

func (tx *DAO) LockCredential(ctx context.Context, principal model.Principal, now time.Time) error {
	return tx.credential(ctx, principal, now, " FOR SHARE")
}
func (tx *DAO) ReadCredential(ctx context.Context, principal model.Principal, now time.Time) error {
	return tx.credential(ctx, principal, now, "")
}
func (tx *DAO) credential(ctx context.Context, principal model.Principal, now time.Time, lock string) error {
	if principal.Kind == model.OAuthCredential {
		credential, err := pginternal.ThreadCredential(ctx, tx.tx, principal, lock)
		if err != nil {
			return err
		}
		// Check the database clock after acquiring the row lock: a natural expiry
		// can occur while revocation or another writer holds the row.
		var valid bool
		if err := tx.tx.QueryRow(ctx, `SELECT $1::timestamptz > clock_timestamp()`, credential.ExpiresAt).Scan(&valid); err != nil {
			return pginternal.QueryError("recheck session credential expiry", err)
		}
		if !valid {
			return model.ErrNotFound
		}
		return nil
	}
	table := "sessions"
	predicate := "expires_at>$3"
	if principal.Kind == model.PATCredential {
		table = "personal_access_tokens"
		predicate = "(expires_at IS NULL OR expires_at>$3)"
	} else if principal.Kind != model.SessionCredential {
		return model.ErrNotFound
	}
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM `+table+` WHERE id=$1 AND user_id=$2 AND `+predicate+lock, principal.CredentialID, principal.UserID, now).Scan(&id)
	if err != nil {
		return pginternal.QueryError("lock session credential", err)
	}
	return nil
}

func (tx *DAO) ProjectAccess(ctx context.Context, userID, projectID string) (model.ProjectAccess, error) {
	access, err := pginternal.ReadProjectAccess(ctx, tx.tx, userID, projectID)
	if !errors.Is(err, model.ErrNotFound) {
		return access, err
	}
	var deleted bool
	if queryErr := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND deleted_at IS NOT NULL)`, projectID).Scan(&deleted); queryErr != nil {
		return model.ProjectAccess{}, pginternal.QueryError("check session project lifecycle", queryErr)
	}
	if deleted {
		return model.ProjectAccess{}, store.ErrSessionProjectNotFound
	}
	return access, err
}

func (tx *DAO) LockTask(ctx context.Context, project, id string) (store.SessionTask, error) {
	task, err := tx.lockTaskResource(ctx, project, id, false)
	if err != nil {
		return store.SessionTask{}, err
	}
	if task.Deleted {
		return store.SessionTask{}, model.ErrNotFound
	}
	return task, nil
}

// lockTaskResource acquires the complete final lock set before reading facts.
func (tx *DAO) lockTaskResource(ctx context.Context, project, id string, update bool) (store.SessionTask, error) {
	presence, err := pginternal.LockTaskResource(ctx, tx.tx, project, id, update)
	if err != nil {
		return store.SessionTask{}, err
	}
	if !presence.Found {
		return store.SessionTask{}, model.ErrNotFound
	}
	if err := tx.ensureLiveProject(ctx, project); err != nil {
		return store.SessionTask{}, err
	}
	task := store.SessionTask{Deleted: presence.DeletedAt != nil}
	if err := tx.tx.QueryRow(ctx, `SELECT status,type FROM task_resource_rows WHERE project_id=$1 AND id=$2`, project, id).Scan(&task.Status, &task.Type); err != nil {
		return store.SessionTask{}, pginternal.QueryError("read session task", err)
	}
	return tx.sessionTaskProperties(ctx, id, task)
}

// Session admission must re-read project lifecycle after the Task lock wait,
// before decoding Task properties or applying the archive exception.
func (tx *DAO) ensureLiveProject(ctx context.Context, project string) error {
	var live bool
	if err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND deleted_at IS NULL)`, project).Scan(&live); err != nil {
		return pginternal.QueryError("check session project lifecycle", err)
	}
	if !live {
		return model.ErrNotFound
	}
	return nil
}

func (tx *DAO) sessionTaskProperties(ctx context.Context, id string, task store.SessionTask) (store.SessionTask, error) {
	rows, err := tx.tx.Query(ctx, `SELECT name,value FROM task_properties WHERE task_id=$1 ORDER BY name`, id)
	if err != nil {
		return store.SessionTask{}, pginternal.QueryError("read session task properties", err)
	}
	defer rows.Close()
	properties := model.TaskProperties{}
	for rows.Next() {
		var name, value string
		if err := rows.Scan(&name, &value); err != nil {
			return store.SessionTask{}, pginternal.QueryError("read session task properties", err)
		}
		properties[name] = json.RawMessage(value)
	}
	if err := rows.Err(); err != nil {
		return store.SessionTask{}, pginternal.QueryError("read session task properties", err)
	}
	task.Worker, err = taskproperties.Worker(properties)
	if err != nil {
		return task, err
	}
	task.StartupReport, err = taskproperties.SessionStartup(properties)
	return task, err
}

func (tx *DAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	var botID *string
	if err := tx.tx.QueryRow(ctx, `SELECT bot_id::text FROM task_sessions WHERE id=$1 AND backend='web'`, id).Scan(&botID); err != nil {
		return nil, pginternal.QueryError("read session bot", err)
	}
	return botID, nil
}

func (tx *DAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	var r store.SessionRecord
	var raw []byte
	var parent, kind, connectionParent *string
	err := tx.tx.QueryRow(ctx, `SELECT bot_id::text,server_instance::text,snapshot,owner_user_id::text,parent_credential_id::text,registration,source_epoch::text,source_epochs::text[],last_source_seq,last_operation_seq,grant_hash,grant_expires_at,connection_expires_at,last_seen,draining_until,grant_kind,grant_consumed,stop_proof,connection_parent_credential_id::text,draining_timeline_seq,EXISTS(SELECT 1 FROM session_operations WHERE session_id=task_sessions.id AND command->>'kind'='send_message' AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted','confirmed','unknown')) FROM task_sessions WHERE id=$1 AND backend='web' FOR UPDATE`, id).Scan(&r.BotID, &r.ServerInstance, &raw, &r.Owner, &parent, &r.Registration, &r.SourceEpoch, &r.SourceEpochs, &r.SourceSeq, &r.OperationSeq, &r.GrantHash, &r.GrantExpiry, &r.ConnectionExpiry, &r.LastSeen, &r.DrainUntil, &kind, &r.Consumed, &r.StopProof, &connectionParent, &r.DrainTimelineSeq, &r.FirstInputBlocked)
	if err != nil {
		return store.SessionRecord{}, pginternal.QueryError("lock session", err)
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
		return store.SessionRecord{}, pginternal.QueryError("decode session", err)
	}
	return r, nil
}

func (tx *DAO) SaveSession(ctx context.Context, r store.SessionRecord) error {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return pginternal.QueryError("encode session", err)
	}
	_, err = tx.tx.Exec(ctx, `UPDATE task_sessions SET snapshot=$2,source_epoch=$3,source_epochs=$4,last_source_seq=$5,last_operation_seq=$6 WHERE id=$1`, r.Snapshot.SessionID, raw, r.SourceEpoch, r.SourceEpochs, r.SourceSeq, r.OperationSeq)
	if err != nil {
		return pginternal.QueryError("save session", err)
	}
	return nil
}

func (tx *DAO) LockTaskRegistration(ctx context.Context, project, taskID string) (store.SessionTask, error) {
	task, err := tx.lockTaskResource(ctx, project, taskID, true)
	if err != nil {
		return store.SessionTask{}, err
	}
	if task.Deleted {
		return store.SessionTask{}, model.ErrNotFound
	}
	return task, nil
}

func (tx *DAO) LockTestOwner(ctx context.Context, userID string) error {
	_, err := tx.tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID)
	if err != nil {
		return pginternal.QueryError("lock test owner", err)
	}
	return nil
}

func (tx *DAO) FindTaskRegistration(ctx context.Context, project, registration, taskID, claim string) (string, error) {
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND (registration_id=$2 OR (task_id=$3 AND claim_id=$4))`, project, registration, taskID, claim).Scan(&id)
	if err != nil {
		return "", pginternal.QueryError("find task session registration", err)
	}
	return id, nil
}

func (tx *DAO) FindTestRegistration(ctx context.Context, owner, registration, execution string) (string, *string, error) {
	var id string
	var botID *string
	err := tx.tx.QueryRow(ctx, `SELECT id::text,bot_id::text FROM task_sessions WHERE scope='test' AND owner_user_id=$1 AND (registration_id=$2 OR test_execution_id=$3)`, owner, registration, execution).Scan(&id, &botID)
	if err != nil {
		return "", nil, pginternal.QueryError("find test session registration", err)
	}
	return id, botID, nil
}

func (tx *DAO) InsertTaskSession(ctx context.Context, r store.SessionRegistration) error {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return pginternal.QueryError("encode session registration", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, r.Location.SessionID, r.Location.ProjectID, r.Location.TaskID, r.ClaimID, r.OwnerID, r.RegistrationID, r.Registration, raw)
	if err != nil {
		return pginternal.QueryError("insert task session", err)
	}
	return nil
}

func (tx *DAO) InsertTestSession(ctx context.Context, r store.SessionRegistration) error {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return pginternal.QueryError("encode session registration", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id) VALUES($1,'test',$2,$3,$4,$5,$6,$7)`, r.Location.SessionID, r.TestExecutionID, r.OwnerID, r.RegistrationID, r.Registration, raw, r.ParentCredentialID)
	if err != nil {
		return pginternal.QueryError("insert test session", err)
	}
	return nil
}

func (tx *DAO) ArchiveMetadata(ctx context.Context, id string) (store.ArchiveMetadata, error) {
	var m store.ArchiveMetadata
	err := tx.tx.QueryRow(ctx, `SELECT s.owner_user_id::text, COALESCE(s.parent_credential_id::text,''), COALESCE(s.project_id::text,''), COALESCE(s.task_id::text,''), s.backend, s.scope='test',
 EXISTS(SELECT 1 FROM task_resource_rows t WHERE t.id=s.task_id AND t.project_id=s.project_id),
 COALESCE((SELECT t.effective_deleted_at IS NOT NULL FROM task_resource_rows t WHERE t.id=s.task_id AND t.project_id=s.project_id),false),
 EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.deleted_at IS NULL),
 s.bot_id IS NULL OR EXISTS(SELECT 1 FROM bots b WHERE b.id=s.bot_id AND b.deletion IS NULL AND b.session_id=s.id)
 FROM task_sessions s WHERE s.id=$1`, id).Scan(&m.Owner, &m.Parent, &m.Project, &m.Task, &m.Backend, &m.Test, &m.TaskExists, &m.TaskDeleted, &m.ProjectLive, &m.BotValid)
	if err != nil {
		return store.ArchiveMetadata{}, pginternal.QueryError("read archive metadata", err)
	}
	return m, nil
}

func (tx *DAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	location := store.SessionLocation{SessionID: id}
	err := tx.tx.QueryRow(ctx, `SELECT COALESCE(project_id::text,''),COALESCE(task_id::text,'') FROM task_sessions WHERE id=$1`, id).Scan(&location.ProjectID, &location.TaskID)
	if err != nil {
		return store.SessionLocation{}, pginternal.QueryError("read session scope", err)
	}
	return location, nil
}

func (tx *DAO) SessionLocationByGrant(ctx context.Context, hash []byte) (store.SessionLocation, error) {
	var location store.SessionLocation
	err := tx.tx.QueryRow(ctx, `SELECT COALESCE(project_id::text,''),COALESCE(task_id::text,''),id::text FROM task_sessions WHERE grant_hash=$1`, hash).Scan(&location.ProjectID, &location.TaskID, &location.SessionID)
	if err != nil {
		return store.SessionLocation{}, pginternal.QueryError("read session grant", err)
	}
	return location, nil
}

func (tx *DAO) CurrentTaskSession(ctx context.Context, project, taskID, claim string) (string, error) {
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND claim_id=$3`, project, taskID, claim).Scan(&id)
	if err != nil {
		return "", pginternal.QueryError("read current task session", err)
	}
	return id, nil
}

func (tx *DAO) SetSessionGrant(ctx context.Context, g store.SessionGrant) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET grant_hash=$2,grant_expires_at=$3,grant_kind=$4,grant_consumed=false,parent_credential_id=$5 WHERE id=$1`, g.SessionID, g.Hash, g.ExpiresAt, g.Kind, g.ParentCredentialID)
	if err != nil {
		return pginternal.QueryError("set session grant", err)
	}
	return nil
}

func (tx *DAO) SetSessionGenerationStop(ctx context.Context, id string, stopProof []byte) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET stop_proof=$2,connection_expires_at=NULL WHERE id=$1`, id, stopProof)
	if err != nil {
		return pginternal.QueryError("set session generation stop", err)
	}
	return nil
}

func (tx *DAO) SetTestSessionStop(ctx context.Context, id string, stopProof []byte) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET stop_proof=$2,grant_hash=NULL,grant_expires_at=NULL,connection_expires_at=NULL WHERE id=$1`, id, stopProof)
	if err != nil {
		return pginternal.QueryError("stop test session", err)
	}
	return nil
}

func (tx *DAO) ConnectSession(ctx context.Context, id, instance string, now time.Time, expiry *time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET grant_consumed=true,server_instance=$2,connected_at=$3,last_seen=$3,connection_expires_at=$4,connection_parent_credential_id=parent_credential_id WHERE id=$1`, id, instance, now, expiry)
	if err != nil {
		return pginternal.QueryError("connect session", err)
	}
	return nil
}

func (tx *DAO) TouchSession(ctx context.Context, id string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET last_seen=$2 WHERE id=$1`, id, now)
	if err != nil {
		return pginternal.QueryError("touch session", err)
	}
	return nil
}

func (tx *DAO) DisconnectSession(ctx context.Context, id string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET connection_expires_at=NULL WHERE id=$1`, id)
	if err != nil {
		return pginternal.QueryError("disconnect session", err)
	}
	return nil
}

func (tx *DAO) LockBotSessions(ctx context.Context, botID string) ([]store.BotSession, error) {
	rows, err := tx.tx.Query(ctx, `SELECT id::text,owner_user_id::text,scope,backend FROM task_sessions WHERE bot_id=$1 ORDER BY id FOR UPDATE`, botID)
	if err != nil {
		return nil, pginternal.QueryError("lock bot sessions", err)
	}
	defer rows.Close()
	var sessions []store.BotSession
	for rows.Next() {
		var session store.BotSession
		if err := rows.Scan(&session.ID, &session.Owner, &session.Scope, &session.Backend); err != nil {
			return nil, pginternal.QueryError("read bot sessions", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, pginternal.QueryError("read bot sessions", err)
	}
	return sessions, nil
}

func (tx *DAO) RevokeBotSessions(ctx context.Context, botID string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET grant_hash=NULL,grant_expires_at=NULL,connection_expires_at=NULL WHERE bot_id=$1`, botID)
	if err != nil {
		return pginternal.QueryError("revoke bot sessions", err)
	}
	return nil
}

func (tx *DAO) LockBotSessionStop(ctx context.Context, id, botID, owner string) (store.BotSessionStop, error) {
	var result store.BotSessionStop
	var raw []byte
	err := tx.tx.QueryRow(ctx, `SELECT snapshot,grant_consumed,source_epoch::text FROM task_sessions WHERE id=$1 AND bot_id=$2 AND owner_user_id=$3 AND scope='test' AND backend='web' FOR UPDATE`, id, botID, owner).Scan(&raw, &result.Consumed, &result.SourceEpoch)
	if err != nil {
		return store.BotSessionStop{}, pginternal.QueryError("lock bot session stop", err)
	}
	if err := json.Unmarshal(raw, &result.Snapshot); err != nil {
		return store.BotSessionStop{}, pginternal.QueryError("decode bot session stop", err)
	}
	return result, nil
}

func (tx *DAO) DeleteBotSession(ctx context.Context, id, botID string) error {
	// Session deletion owns metadata cleanup explicitly, after its file and lease barriers.
	for _, table := range []string{"session_archive_chunks", "session_archive_files", "session_archive_bundles", "session_archive_migrations", "session_operation_intents", "session_resource_references", "session_image_chunks", "session_image_uploads", "session_image_captures", "session_resource_leases", "session_resource_state", "session_media_requests", "session_source_hashes", "session_events", "session_timeline", "session_operations", "session_resources", "session_archives", "session_recording_evidence"} {
		if _, err := tx.tx.Exec(ctx, `DELETE FROM `+table+` WHERE session_id=$1`, id); err != nil {
			return pginternal.QueryError("delete bot session children", err)
		}
	}
	_, err := tx.tx.Exec(ctx, `DELETE FROM task_sessions WHERE id=$1 AND bot_id=$2`, id, botID)
	if err != nil {
		return pginternal.QueryError("delete bot session", err)
	}
	return nil
}

func (tx *DAO) RedactDeletedBot(ctx context.Context, botID string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE bots SET session_id=NULL,role_configuration=NULL,name='Deleted',requested_overrides='{}',resolved_configuration='{}',startup_result='{"state":"failed","code":"deleted"}' WHERE id=$1`, botID)
	if err != nil {
		return pginternal.QueryError("redact deleted bot", err)
	}
	return nil
}

func (tx *DAO) SessionOperation(ctx context.Context, session, id string) (store.SessionOperation, error) {
	o := store.SessionOperation{SessionID: session, OperationID: id}
	var command, receipt []byte
	var kind string
	err := tx.tx.QueryRow(ctx, `SELECT command,receipt,actor_user_id::text,credential_id::text,credential_kind,body_hash,dispatch_epoch,operation_seq,deadline FROM session_operations WHERE session_id=$1 AND operation_id=$2`, session, id).Scan(&command, &receipt, &o.Actor.UserID, &o.Actor.CredentialID, &kind, &o.Hash, &o.Epoch, &o.Seq, &o.Deadline)
	if err != nil {
		return store.SessionOperation{}, pginternal.QueryError("read session operation", err)
	}
	o.Actor.Kind = model.CredentialKind(kind)
	if err = json.Unmarshal(command, &o.Command); err != nil {
		return store.SessionOperation{}, pginternal.QueryError("decode session command", err)
	}
	if err = json.Unmarshal(receipt, &o.Receipt); err != nil {
		return store.SessionOperation{}, pginternal.QueryError("decode session receipt", err)
	}
	return o, nil
}

func (tx *DAO) InsertSessionOperation(ctx context.Context, o store.SessionOperation) error {
	command, err := json.Marshal(o.Command)
	if err != nil {
		return pginternal.QueryError("encode session command", err)
	}
	receipt, err := json.Marshal(o.Receipt)
	if err != nil {
		return pginternal.QueryError("encode session receipt", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, o.SessionID, o.OperationID, o.Seq, o.Hash, command, o.Actor.UserID, o.Actor.CredentialID, string(o.Actor.Kind), receipt)
	if err != nil {
		return pginternal.QueryError("insert session operation", err)
	}
	return nil
}

func (tx *DAO) SetSessionOperationReceipt(ctx context.Context, o sp.Operation) error {
	raw, err := json.Marshal(o)
	if err != nil {
		return pginternal.QueryError("encode session receipt", err)
	}
	_, err = tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=$3 WHERE session_id=$1 AND operation_id=$2`, o.SessionID, o.OperationID, raw)
	if err != nil {
		return pginternal.QueryError("set session receipt", err)
	}
	return nil
}

func (tx *DAO) SetSessionOperationEpoch(ctx context.Context, session, id string, epoch int64) error {
	_, err := tx.tx.Exec(ctx, `UPDATE session_operations SET dispatch_epoch=$3 WHERE session_id=$1 AND operation_id=$2`, session, id, epoch)
	if err != nil {
		return pginternal.QueryError("set session operation epoch", err)
	}
	return nil
}

func (tx *DAO) HasOtherFirstInput(ctx context.Context, session, id string) (bool, error) {
	var exists bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND operation_id<>$2 AND command->>'kind'='send_message' AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted','confirmed','unknown'))`, session, id).Scan(&exists)
	if err != nil {
		return false, pginternal.QueryError("read session first input", err)
	}
	return exists, nil
}

func (tx *DAO) HasInteractionResponse(ctx context.Context, session, id, interaction string) (bool, error) {
	var exists bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND operation_id<>$2 AND command->>'kind'='interaction_response' AND command->'payload'->>'interactionId'=$3 AND receipt->>'state' NOT IN ('rejected','expired','failed'))`, session, id, interaction).Scan(&exists)
	if err != nil {
		return false, pginternal.QueryError("read session interaction response", err)
	}
	return exists, nil
}

func (tx *DAO) PendingSessionOperationCount(ctx context.Context, session string) (int, error) {
	var count int
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted')`, session).Scan(&count)
	if err != nil {
		return 0, pginternal.QueryError("count pending session operations", err)
	}
	return count, nil
}

func (tx *DAO) AcceptedSessionOperations(ctx context.Context, session string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state'='accepted' ORDER BY operation_seq LIMIT 100`, session)
	if err != nil {
		return nil, pginternal.QueryError("read accepted session operations", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pginternal.QueryError("read accepted session operations", err)
	}
	return ids, nil
}

func (tx *DAO) StoppingTestOperations(ctx context.Context, session string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('accepted','offered','dispatching')`, session)
	if err != nil {
		return nil, pginternal.QueryError("read stopping test operations", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pginternal.QueryError("read stopping test operations", err)
	}
	return ids, nil
}

func (tx *DAO) UnreconciledSessionOperations(ctx context.Context, session string, epoch int64) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND dispatch_epoch IS DISTINCT FROM $2 AND receipt->>'state' IN ('offered','dispatching') ORDER BY operation_seq LIMIT 100`, session, epoch)
	if err != nil {
		return nil, pginternal.QueryError("read unreconciled session operations", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pginternal.QueryError("read unreconciled session operations", err)
	}
	return ids, nil
}

func (tx *DAO) UnreconciledSessionOperationCount(ctx context.Context, session string, epoch int64) (int, error) {
	var count int
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1 AND dispatch_epoch IS DISTINCT FROM $2 AND receipt->>'state' IN ('offered','dispatching')`, session, epoch).Scan(&count)
	if err != nil {
		return 0, pginternal.QueryError("count unreconciled session operations", err)
	}
	return count, nil
}

func (tx *DAO) LockArchiveTask(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
	task, err := tx.lockTaskResource(ctx, project, id, false)
	return task, task.Deleted, err
}

func (tx *DAO) SessionArchive(ctx context.Context, id string) (sp.ArchiveStatus, string, error) {
	status := sp.ArchiveStatus{State: "unavailable"}
	var path *string
	var schemaVersion int
	var completeness *string
	err := tx.tx.QueryRow(ctx, `SELECT state,sha256,byte_length::text,error_code,object_path,schema_version,completeness FROM session_archives WHERE session_id=$1`, id).Scan(&status.State, &status.SHA256, &status.ByteLength, &status.ErrorCode, &path, &schemaVersion, &completeness)
	if schemaVersion == 3 {
		status.SchemaVersion = 3
		status.Completeness = completeness
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return sp.ArchiveStatus{State: "unavailable"}, "", nil
	}
	if err != nil {
		return sp.ArchiveStatus{}, "", pginternal.QueryError("read session archive", err)
	}
	if path != nil {
		return status, *path, nil
	}
	return status, "", nil
}

func (tx *DAO) SetSessionArchiveState(ctx context.Context, id, state string, code *string) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,error_code) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,updated_at=now()`, id, state, code)
	if err != nil {
		return pginternal.QueryError("set session archive state", err)
	}
	return nil
}

func (tx *DAO) SetSessionArchiveReady(ctx context.Context, id, digest string, size int, path string) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path) VALUES($1,'ready',$2,$3,$4) ON CONFLICT(session_id) DO UPDATE SET state='ready',sha256=excluded.sha256,byte_length=excluded.byte_length,object_path=excluded.object_path,error_code=NULL,updated_at=now()`, id, digest, size, path)
	if err != nil {
		return pginternal.QueryError("set session archive ready", err)
	}
	return nil
}

func (tx *DAO) ListTestSessions(ctx context.Context, owner string, now time.Time, limit int, online bool, heartbeatFloor time.Time, after *time.Time, afterID string) ([]store.TestSessionListItem, error) {
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
		return nil, pginternal.QueryError("list test sessions", err)
	}
	defer rows.Close()
	var result []store.TestSessionListItem
	for rows.Next() {
		var item store.TestSessionListItem
		var raw []byte
		if err := rows.Scan(&raw, &item.CreatedAt, &item.UpdatedAt, &item.LastSeen, &item.DrainUntil); err != nil {
			return nil, pginternal.QueryError("read test sessions", err)
		}
		if err := json.Unmarshal(raw, &item.Snapshot); err != nil {
			return nil, pginternal.QueryError("decode test session", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, pginternal.QueryError("read test sessions", err)
	}
	return result, nil
}

func (tx *DAO) LockTerminal(ctx context.Context, id string) ([]byte, error) {
	var raw []byte
	if err := tx.tx.QueryRow(ctx, `SELECT terminal_state FROM task_sessions WHERE id=$1 AND backend='herdr' FOR UPDATE`, id).Scan(&raw); err != nil {
		return nil, pginternal.QueryError("lock terminal", err)
	}
	return raw, nil
}

func (tx *DAO) SaveTerminal(ctx context.Context, id string, raw []byte, seen *time.Time, instance string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET terminal_state=$2,last_seen=$3,server_instance=$4 WHERE id=$1 AND backend='herdr'`, id, raw, seen, instance)
	if err != nil {
		return pginternal.QueryError("save terminal", err)
	}
	return nil
}

func (tx *DAO) FindTerminalRegistration(ctx context.Context, id, project, registration, taskID, claim string) (string, error) {
	var found string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE id=$1 OR (project_id=$2 AND (registration_id=$3 OR (task_id=$4 AND claim_id=$5)))`, id, project, registration, taskID, claim).Scan(&found)
	if err != nil {
		return "", pginternal.QueryError("find terminal registration", err)
	}
	return found, nil
}

func (tx *DAO) InsertTerminal(ctx context.Context, r store.TerminalRegistration) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state,last_seen,server_instance) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'herdr',$8,$9,$10)`, r.SessionID, r.ProjectID, r.TaskID, r.ClaimID, r.OwnerID, r.RegistrationID, r.Registration, r.State, r.LastSeen, r.ServerInstance)
	if err != nil {
		return pginternal.QueryError("insert terminal", err)
	}
	return nil
}

func (tx *DAO) InsertRecordingEvidence(ctx context.Context, id string, generation int64, evidenceID string, revision int64, hash string) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_recording_evidence(session_id,execution_generation,evidence_id,revision,body_hash) VALUES($1,$2,$3,$4,$5)`, id, generation, evidenceID, revision, hash)
	if err != nil {
		return pginternal.QueryError("insert recording evidence", err)
	}
	return nil
}

func (tx *DAO) TerminalOperation(ctx context.Context, id, operationID string) (store.TerminalOperation, error) {
	out := store.TerminalOperation{SessionID: id, OperationID: operationID}
	var result []byte
	var kind string
	err := tx.tx.QueryRow(ctx, `SELECT command,receipt,actor_user_id::text,credential_id::text,credential_kind,body_hash,dispatch_epoch,deadline FROM session_operations WHERE session_id=$1 AND operation_id=$2`, id, operationID).Scan(&out.Command, &result, &out.Actor.UserID, &out.Actor.CredentialID, &kind, &out.Hash, &out.Epoch, &out.Deadline)
	if err != nil {
		return store.TerminalOperation{}, pginternal.QueryError("read terminal operation", err)
	}
	out.Actor.Kind = model.CredentialKind(kind)
	if err := json.Unmarshal(result, &out.Result); err != nil {
		return store.TerminalOperation{}, pginternal.QueryError("decode terminal result", err)
	}
	return out, nil
}

func (tx *DAO) InsertTerminalOperation(ctx context.Context, o store.TerminalOperation) error {
	raw, err := json.Marshal(o.Result)
	if err != nil {
		return pginternal.QueryError("encode terminal result", err)
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, o.SessionID, o.OperationID, o.Seq, o.Hash, o.Command, o.Actor.UserID, o.Actor.CredentialID, string(o.Actor.Kind), raw, o.Deadline)
	if err != nil {
		return pginternal.QueryError("insert terminal operation", err)
	}
	return nil
}

func (tx *DAO) SetTerminalOperationResult(ctx context.Context, id string, result v2.OperationResult) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return pginternal.QueryError("encode terminal result", err)
	}
	_, err = tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=$3 WHERE session_id=$1 AND operation_id=$2`, id, result.OperationID, raw)
	if err != nil {
		return pginternal.QueryError("set terminal result", err)
	}
	return nil
}

func (tx *DAO) InvalidateTerminalOperations(ctx context.Context, id string) error {
	_, err := tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=jsonb_build_object('operationId',operation_id::text,'state',CASE WHEN receipt->>'state'='queued' THEN 'rejected' ELSE 'unknown' END,'errorCode',CASE WHEN receipt->>'state'='queued' THEN 'stale_fence' ELSE 'input_unknown' END) WHERE session_id=$1 AND receipt->>'state' IN ('queued','dispatching')`, id)
	if err != nil {
		return pginternal.QueryError("invalidate terminal operations", err)
	}
	return nil
}

func (tx *DAO) ExpireTerminalOperations(ctx context.Context, id string, now time.Time) error {
	_, err := tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=jsonb_build_object('operationId',operation_id::text,'state',CASE WHEN receipt->>'state'='queued' THEN 'rejected' ELSE 'unknown' END,'errorCode',CASE WHEN receipt->>'state'='queued' THEN 'input_busy' ELSE 'input_unknown' END) WHERE session_id=$1 AND deadline<=$2 AND receipt->>'state' IN ('queued','dispatching')`, id, now)
	if err != nil {
		return pginternal.QueryError("expire terminal operations", err)
	}
	return nil
}

func (tx *DAO) QueuedTerminalOperation(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state'='queued' ORDER BY operation_seq LIMIT 1`, id)
	if err != nil {
		return nil, pginternal.QueryError("read queued terminal operation", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pginternal.QueryError("read queued terminal operation", err)
	}
	return ids, nil
}

func (tx *DAO) TerminalViewerOperationPending(ctx context.Context, id, user, client string) (bool, error) {
	var pending bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND actor_user_id=$2 AND command->'request'->>'browserClientId'=$3 AND receipt->>'state' IN ('queued','dispatching'))`, id, user, client).Scan(&pending)
	if err != nil {
		return false, pginternal.QueryError("read terminal viewer operation", err)
	}
	return pending, nil
}

func (tx *DAO) InsertBotSession(ctx context.Context, r store.SessionRegistration) (bool, error) {
	raw, err := json.Marshal(r.Snapshot)
	if err != nil {
		return false, pginternal.QueryError("encode bot session", err)
	}
	tag, err := tx.tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,bot_id) VALUES($1,'test',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, r.Location.SessionID, r.TestExecutionID, r.OwnerID, r.RegistrationID, r.Registration, raw, r.ParentCredentialID, r.BotID)
	if err != nil {
		return false, pginternal.QueryError("insert bot session", err)
	}
	return tag.RowsAffected() == 1, nil
}
