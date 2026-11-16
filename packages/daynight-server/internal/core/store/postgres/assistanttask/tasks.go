package assistanttask

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const taskColumns = `t.id::text,t.owner_user_id::text,t.application,t.name,t.purpose,t.scope,t.kind,t.state,t.takeover,t.request_fingerprint,t.trigger,t.version,t.manual_version,t.claim_generation,t.holder_bot_id::text,t.claim_token_hash,t.credential_operation_id::text,t.claimed_at,t.renewed_at,t.lease_until,t.created_at,t.updated_at,
 (t.holder_bot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bots b WHERE b.id=t.holder_bot_id AND b.owner_user_id=t.owner_user_id AND b.deletion IS NULL)),clock_timestamp()`

func scanTask(row pgx.Row) (model.AssistantTask, error) {
	var v model.AssistantTask
	err := row.Scan(&v.ID, &v.OwnerUserID, &v.Application, &v.Name, &v.Purpose, &v.Scope, &v.Kind, &v.State, &v.Takeover, &v.RequestFingerprint, &v.Trigger, &v.Version, &v.ManualVersion, &v.ClaimGeneration, &v.HolderBotID, &v.ClaimTokenHash, &v.CredentialOperationID, &v.ClaimedAt, &v.RenewedAt, &v.LeaseUntil, &v.CreatedAt, &v.UpdatedAt, &v.HolderDeleted, &v.ObservedAt)
	v.ObservedAt = v.ObservedAt.UTC()
	v.CreatedAt, v.UpdatedAt = v.CreatedAt.UTC(), v.UpdatedAt.UTC()
	v.ClaimedAt, v.RenewedAt, v.LeaseUntil = pg.UTCTime(v.ClaimedAt), pg.UTCTime(v.RenewedAt), pg.UTCTime(v.LeaseUntil)
	return v, err
}

func (d *DAO) Task(ctx context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
	var identity model.AssistantTask
	if err := d.tx.QueryRow(ctx, `SELECT id::text,owner_user_id::text FROM assistant_tasks WHERE id=$1`, id).Scan(&identity.ID, &identity.OwnerUserID); err != nil {
		return model.AssistantTask{}, pg.QueryError("read assistant task identity", err)
	}
	if identity.OwnerUserID != owner {
		return identity, nil
	}
	if lock {
		var found string
		if err := d.tx.QueryRow(ctx, `SELECT id::text FROM assistant_tasks WHERE owner_user_id=$1 AND id=$2 FOR UPDATE`, owner, id).Scan(&found); err != nil {
			return model.AssistantTask{}, pg.QueryError("lock assistant task", err)
		}
	}
	// A separate statement sees holder deletion after any task-lock wait.
	return one(d.tx.QueryRow(ctx, `SELECT `+taskColumns+` FROM assistant_tasks t WHERE t.owner_user_id=$1 AND t.id=$2`, owner, id), "read assistant task", scanTask)
}

func (d *DAO) Tasks(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTask, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant tasks", `SELECT `+taskColumns+` FROM assistant_tasks t WHERE t.owner_user_id=$1 AND t.state<>'deleted' AND ($2='' OR t.state=$2) AND ($3::uuid IS NULL OR t.holder_bot_id=$3) AND ($4::timestamptz IS NULL OR (t.created_at,t.id)>($4,$5::uuid)) ORDER BY t.created_at,t.id LIMIT $6`, scanTask, q.OwnerUserID, q.State, nullableID(q.TargetBotID), after, id, limit)
}

func nullableID(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func taskValues(v model.AssistantTask) []any {
	return []any{v.ID, v.OwnerUserID, v.Application, v.Name, v.Purpose, v.Scope, v.Kind, v.State, v.Takeover, v.RequestFingerprint, v.Trigger, v.Version, v.ManualVersion, v.ClaimGeneration, v.HolderBotID, v.ClaimTokenHash, v.CredentialOperationID, v.ClaimedAt, v.RenewedAt, v.LeaseUntil, v.CreatedAt, v.UpdatedAt}
}

func (d *DAO) InsertTask(ctx context.Context, v model.AssistantTask) (bool, error) {
	return d.changed(ctx, "insert assistant task", `INSERT INTO assistant_tasks(id,owner_user_id,application,name,purpose,scope,kind,state,takeover,request_fingerprint,trigger,version,manual_version,claim_generation,holder_bot_id,claim_token_hash,credential_operation_id,claimed_at,renewed_at,lease_until,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT DO NOTHING`, taskValues(v)...)
}

func (d *DAO) SaveTask(ctx context.Context, v model.AssistantTask, c store.AssistantTaskCondition) (bool, error) {
	// Evaluate the lease in a new statement after acquiring the row lock. A
	// predicate evaluated before a lock wait may otherwise admit an expired lease.
	var locked string
	if err := d.tx.QueryRow(ctx, `SELECT id::text FROM assistant_tasks WHERE owner_user_id=$1 AND id=$2 FOR UPDATE`, v.OwnerUserID, v.ID).Scan(&locked); err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, pg.QueryError("lock assistant task for save", err)
	}
	values := append(taskValues(v), c.Version, c.CheckClaim, c.Generation, c.HolderBotID, c.TokenHash, c.LiveClaim)
	return d.changed(ctx, "save assistant task", `UPDATE assistant_tasks SET application=$3,name=$4,purpose=$5,scope=$6,kind=$7,state=$8,takeover=$9,request_fingerprint=$10,trigger=$11,version=$12,manual_version=$13,claim_generation=$14,holder_bot_id=$15,claim_token_hash=$16,credential_operation_id=$17,claimed_at=$18,renewed_at=$19,lease_until=$20,created_at=$21,updated_at=$22 WHERE id=$1 AND owner_user_id=$2 AND ($23::bigint=0 OR version=$23) AND (NOT $24 OR (claim_generation=$25 AND holder_bot_id IS NOT DISTINCT FROM $26::uuid AND claim_token_hash IS NOT DISTINCT FROM $27::text)) AND (NOT $28 OR (lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM bots b WHERE b.id=assistant_tasks.holder_bot_id AND b.owner_user_id=$2 AND b.deletion IS NULL)))`, values...)
}

func (d *DAO) DeleteTaskContent(ctx context.Context, owner, task string) error {
	for _, table := range []string{"assistant_task_claim_operations", "assistant_task_inquiries", "assistant_task_events", "assistant_task_records", "assistant_task_items", "assistant_task_proposals", "assistant_task_appendix", "assistant_task_manual_versions"} {
		if err := d.execute(ctx, "delete assistant task content", `DELETE FROM `+table+` WHERE owner_user_id=$1 AND task_id=$2`, owner, task); err != nil {
			return err
		}
	}
	return d.execute(ctx, "clear assistant record head", `UPDATE assistant_tasks SET record_last_created_at=NULL,record_last_id=NULL WHERE owner_user_id=$1 AND id=$2`, owner, task)
}

const operationColumns = `owner_user_id::text,task_id::text,operation_id::text,kind,actor_bot_id::text,request_fingerprint,admitted_at,resulting_version,resulting_generation,holder_bot_id::text,credential_operation_id::text,lease_until`

func scanOperation(row pgx.Row) (model.AssistantTaskClaimOperation, error) {
	var v model.AssistantTaskClaimOperation
	err := row.Scan(&v.OwnerUserID, &v.TaskID, &v.OperationID, &v.Kind, &v.ActorBotID, &v.RequestFingerprint, &v.AdmittedAt, &v.ResultingVersion, &v.ResultingGeneration, &v.HolderBotID, &v.CredentialOperationID, &v.LeaseUntil)
	v.AdmittedAt = v.AdmittedAt.UTC()
	v.LeaseUntil = pg.UTCTime(v.LeaseUntil)
	return v, err
}

func (d *DAO) ClaimOperation(ctx context.Context, owner, task, id string) (model.AssistantTaskClaimOperation, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+operationColumns+` FROM assistant_task_claim_operations WHERE owner_user_id=$1 AND task_id=$2 AND operation_id=$3`, owner, task, id), "read assistant claim receipt", scanOperation)
}

func (d *DAO) InsertClaimOperation(ctx context.Context, v model.AssistantTaskClaimOperation) error {
	return d.execute(ctx, "insert assistant claim receipt", `INSERT INTO assistant_task_claim_operations(owner_user_id,task_id,operation_id,kind,actor_bot_id,request_fingerprint,admitted_at,resulting_version,resulting_generation,holder_bot_id,credential_operation_id,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, v.OwnerUserID, v.TaskID, v.OperationID, v.Kind, v.ActorBotID, v.RequestFingerprint, v.AdmittedAt, v.ResultingVersion, v.ResultingGeneration, v.HolderBotID, v.CredentialOperationID, v.LeaseUntil)
}

// ApplicationTask reads the nondeleted singleton selected by its unique index.
func (d *DAO) ApplicationTask(ctx context.Context, owner, application string) (model.AssistantTask, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+taskColumns+` FROM assistant_tasks t WHERE t.owner_user_id=$1 AND t.application=$2 AND t.state<>'deleted'`, owner, application), "read assistant application task", scanTask)
}
