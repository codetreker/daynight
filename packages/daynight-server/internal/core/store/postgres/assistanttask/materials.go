package assistanttask

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const manualColumns = `owner_user_id::text,task_id::text,version,body,rules,source,proposal_id::text,created_at`

func scanManual(row pgx.Row) (model.AssistantTaskManual, error) {
	var v model.AssistantTaskManual
	err := row.Scan(&v.OwnerUserID, &v.TaskID, &v.Version, &v.Body, &v.Rules, &v.Source, &v.ProposalID, &v.CreatedAt)
	v.CreatedAt = v.CreatedAt.UTC()
	return v, err
}
func (d *DAO) Manual(ctx context.Context, owner, task string, version int64) (model.AssistantTaskManual, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+manualColumns+` FROM assistant_task_manual_versions WHERE owner_user_id=$1 AND task_id=$2 AND version=$3`, owner, task, version), "read assistant manual", scanManual)
}
func (d *DAO) Manuals(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskManual, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant manuals", `SELECT `+manualColumns+` FROM assistant_task_manual_versions WHERE owner_user_id=$1 AND task_id=$2 AND ($3::timestamptz IS NULL OR (created_at,version)>($3,$4::bigint)) ORDER BY created_at,version LIMIT $5`, scanManual, q.OwnerUserID, q.TaskID, after, id, limit)
}
func (d *DAO) InsertManual(ctx context.Context, v model.AssistantTaskManual) error {
	return d.execute(ctx, "insert assistant manual", `INSERT INTO assistant_task_manual_versions(owner_user_id,task_id,version,body,rules,source,proposal_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, v.OwnerUserID, v.TaskID, v.Version, v.Body, v.Rules, v.Source, v.ProposalID, v.CreatedAt)
}

const appendixColumns = `id::text,owner_user_id::text,task_id::text,text,state,request_fingerprint,source_records,author_bot_id::text,version,created_at,updated_at,scope_project_ids,scope_event_types,scope_item_categories,success_count,failure_count,last_validated_at`

func scanAppendix(row pgx.Row) (model.AssistantTaskAppendix, error) {
	var v model.AssistantTaskAppendix
	err := row.Scan(&v.ID, &v.OwnerUserID, &v.TaskID, &v.Text, &v.State, &v.RequestFingerprint, &v.SourceRecords, &v.AuthorBotID, &v.Version, &v.CreatedAt, &v.UpdatedAt, &v.Scope.ProjectIDs, &v.Scope.EventTypes, &v.Scope.ItemCategories, &v.SuccessCount, &v.FailureCount, &v.LastValidatedAt)
	v.CreatedAt, v.UpdatedAt = v.CreatedAt.UTC(), v.UpdatedAt.UTC()
	v.LastValidatedAt = pg.UTCTime(v.LastValidatedAt)
	return v, err
}
func (d *DAO) Appendix(ctx context.Context, owner, task, id string) (model.AssistantTaskAppendix, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+appendixColumns+` FROM assistant_task_appendix WHERE owner_user_id=$1 AND task_id=$2 AND id=$3`, owner, task, id), "read assistant appendix", scanAppendix)
}
func (d *DAO) Appendices(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskAppendix, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant appendices", `SELECT `+appendixColumns+` FROM assistant_task_appendix WHERE owner_user_id=$1 AND task_id=$2 AND ($3='' OR state=$3) AND ($4::timestamptz IS NULL OR (created_at,id)>($4,$5::uuid)) ORDER BY created_at,id LIMIT $6`, scanAppendix, q.OwnerUserID, q.TaskID, q.State, after, id, limit)
}

// scopeSet stores an unrestricted dimension as an empty JSON array, never null.
func scopeSet(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
func appendixValues(v model.AssistantTaskAppendix) []any {
	return []any{v.ID, v.OwnerUserID, v.TaskID, v.Text, v.State, v.RequestFingerprint, v.SourceRecords, v.AuthorBotID, v.Version, v.CreatedAt, v.UpdatedAt, scopeSet(v.Scope.ProjectIDs), scopeSet(v.Scope.EventTypes), scopeSet(v.Scope.ItemCategories), v.SuccessCount, v.FailureCount, v.LastValidatedAt}
}
func (d *DAO) InsertAppendix(ctx context.Context, v model.AssistantTaskAppendix) (bool, error) {
	return d.changed(ctx, "insert assistant appendix", `INSERT INTO assistant_task_appendix(id,owner_user_id,task_id,text,state,request_fingerprint,source_records,author_bot_id,version,created_at,updated_at,scope_project_ids,scope_event_types,scope_item_categories,success_count,failure_count,last_validated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING`, appendixValues(v)...)
}
func (d *DAO) SaveAppendix(ctx context.Context, v model.AssistantTaskAppendix, version int64) (bool, error) {
	return d.changed(ctx, "save assistant appendix", `UPDATE assistant_task_appendix SET text=$4,state=$5,request_fingerprint=$6,source_records=$7,author_bot_id=$8,version=$9,created_at=$10,updated_at=$11,scope_project_ids=$12,scope_event_types=$13,scope_item_categories=$14,success_count=$15,failure_count=$16,last_validated_at=$17 WHERE id=$1 AND owner_user_id=$2 AND task_id=$3 AND version=$18`, append(appendixValues(v), version)...)
}
func (d *DAO) InsertAppendixValidation(ctx context.Context, v model.AssistantTaskAppendixValidation) (bool, error) {
	return d.changed(ctx, "insert assistant appendix validation", `INSERT INTO assistant_task_appendix_validations(owner_user_id,task_id,appendix_id,outcome_record_id,outcome,validator_bot_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, v.OwnerUserID, v.TaskID, v.AppendixID, v.OutcomeRecordID, v.Outcome, v.ValidatorBotID, v.CreatedAt)
}
func (d *DAO) DeleteAppendixValidations(ctx context.Context, owner, task, appendix string) error {
	return d.execute(ctx, "delete assistant appendix validations", `DELETE FROM assistant_task_appendix_validations WHERE owner_user_id=$1 AND task_id=$2 AND appendix_id=$3`, owner, task, appendix)
}

// relatedAppendixSQL executes the assistanttask module's
// RelatedAppendixMatch filter and score and its CompareRelatedAppendices order:
// an empty query value is neutral, an empty stored set is unrestricted and
// neutral, and a nonempty set either contains the queried value (one point) or
// excludes the appendix. Canonical UUID text order equals uuid order, so the
// final ID tie-break agrees with the module's string comparison.
const relatedAppendixSQL = `SELECT ` + appendixColumns + ` FROM assistant_task_appendix
WHERE owner_user_id=$1 AND task_id=$2 AND state<>'deleted'
 AND ($3='' OR scope_project_ids='[]'::jsonb OR scope_project_ids @> jsonb_build_array($3::text))
 AND ($4='' OR scope_event_types='[]'::jsonb OR scope_event_types @> jsonb_build_array($4::text))
 AND ($5='' OR scope_item_categories='[]'::jsonb OR scope_item_categories @> jsonb_build_array($5::text))
ORDER BY (CASE WHEN $3<>'' AND scope_project_ids @> jsonb_build_array($3::text) THEN 1 ELSE 0 END
 + CASE WHEN $4<>'' AND scope_event_types @> jsonb_build_array($4::text) THEN 1 ELSE 0 END
 + CASE WHEN $5<>'' AND scope_item_categories @> jsonb_build_array($5::text) THEN 1 ELSE 0 END) DESC,
 last_validated_at DESC NULLS LAST, id DESC
LIMIT $6`

func (d *DAO) RelatedAppendices(ctx context.Context, q store.AssistantTaskRelatedQuery) ([]model.AssistantTaskAppendix, error) {
	return many(ctx, d.tx, "list related assistant appendices", relatedAppendixSQL, scanAppendix, q.OwnerUserID, q.TaskID, q.ProjectID, q.EventType, q.ItemCategory, q.Limit)
}

const proposalColumns = `id::text,owner_user_id::text,task_id::text,body,reason,status,decision_note,request_fingerprint,base_version,rules,evidence_records,author_bot_id::text,widens,created_at,decided_at`

func scanProposal(row pgx.Row) (model.AssistantTaskProposal, error) {
	var v model.AssistantTaskProposal
	err := row.Scan(&v.ID, &v.OwnerUserID, &v.TaskID, &v.Body, &v.Reason, &v.Status, &v.DecisionNote, &v.RequestFingerprint, &v.BaseVersion, &v.Rules, &v.EvidenceRecords, &v.AuthorBotID, &v.Widens, &v.CreatedAt, &v.DecidedAt)
	v.CreatedAt = v.CreatedAt.UTC()
	v.DecidedAt = pg.UTCTime(v.DecidedAt)
	return v, err
}
func (d *DAO) Proposal(ctx context.Context, owner, task, id string) (model.AssistantTaskProposal, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+proposalColumns+` FROM assistant_task_proposals WHERE owner_user_id=$1 AND task_id=$2 AND id=$3`, owner, task, id), "read assistant proposal", scanProposal)
}
func (d *DAO) Proposals(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskProposal, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant proposals", `SELECT `+proposalColumns+` FROM assistant_task_proposals WHERE owner_user_id=$1 AND task_id=$2 AND ($3='' OR status=$3) AND ($4::timestamptz IS NULL OR (created_at,id)>($4,$5::uuid)) AND ($7::jsonb IS NULL OR rules=$7::jsonb) ORDER BY created_at,id LIMIT $6`, scanProposal, q.OwnerUserID, q.TaskID, q.State, after, id, limit, q.RulesEqual)
}
func proposalValues(v model.AssistantTaskProposal) []any {
	return []any{v.ID, v.OwnerUserID, v.TaskID, v.Body, v.Reason, v.Status, v.DecisionNote, v.RequestFingerprint, v.BaseVersion, v.Rules, v.EvidenceRecords, v.AuthorBotID, v.Widens, v.CreatedAt, v.DecidedAt}
}
func (d *DAO) InsertProposal(ctx context.Context, v model.AssistantTaskProposal) (bool, error) {
	return d.changed(ctx, "insert assistant proposal", `INSERT INTO assistant_task_proposals(id,owner_user_id,task_id,body,reason,status,decision_note,request_fingerprint,base_version,rules,evidence_records,author_bot_id,widens,created_at,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`, proposalValues(v)...)
}
func (d *DAO) SaveProposal(ctx context.Context, v model.AssistantTaskProposal, status string) (bool, error) {
	return d.changed(ctx, "save assistant proposal", `UPDATE assistant_task_proposals SET body=$4,reason=$5,status=$6,decision_note=$7,request_fingerprint=$8,base_version=$9,rules=$10,evidence_records=$11,author_bot_id=$12,widens=$13,created_at=$14,decided_at=$15 WHERE id=$1 AND owner_user_id=$2 AND task_id=$3 AND status=$16`, append(proposalValues(v), status)...)
}

const itemColumns = `id::text,owner_user_id::text,task_id::text,key,state,category,request_fingerprint,episode,version,follower_bot_id::text,app_state,created_at,updated_at,opened_at,closed_at`

func scanItem(row pgx.Row) (model.AssistantTaskItem, error) {
	var v model.AssistantTaskItem
	err := row.Scan(&v.ID, &v.OwnerUserID, &v.TaskID, &v.Key, &v.State, &v.Category, &v.RequestFingerprint, &v.Episode, &v.Version, &v.FollowerBotID, &v.AppState, &v.CreatedAt, &v.UpdatedAt, &v.OpenedAt, &v.ClosedAt)
	v.CreatedAt, v.UpdatedAt = v.CreatedAt.UTC(), v.UpdatedAt.UTC()
	v.OpenedAt, v.ClosedAt = pg.UTCTime(v.OpenedAt), pg.UTCTime(v.ClosedAt)
	return v, err
}
func (d *DAO) Item(ctx context.Context, owner, task, id string) (model.AssistantTaskItem, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+itemColumns+` FROM assistant_task_items WHERE owner_user_id=$1 AND task_id=$2 AND id=$3`, owner, task, id), "read assistant item", scanItem)
}
func (d *DAO) Items(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskItem, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant items", `SELECT `+itemColumns+` FROM assistant_task_items WHERE owner_user_id=$1 AND task_id=$2 AND ($3='' OR state=$3) AND ($4::timestamptz IS NULL OR (created_at,id)>($4,$5::uuid)) ORDER BY created_at,id LIMIT $6`, scanItem, q.OwnerUserID, q.TaskID, q.State, after, id, limit)
}
func itemValues(v model.AssistantTaskItem) []any {
	return []any{v.ID, v.OwnerUserID, v.TaskID, v.Key, v.State, v.Category, v.RequestFingerprint, v.Episode, v.Version, v.FollowerBotID, v.AppState, v.CreatedAt, v.UpdatedAt, v.OpenedAt, v.ClosedAt}
}
func (d *DAO) InsertItem(ctx context.Context, v model.AssistantTaskItem) (bool, error) {
	return d.changed(ctx, "insert assistant item", `INSERT INTO assistant_task_items(id,owner_user_id,task_id,key,state,category,request_fingerprint,episode,version,follower_bot_id,app_state,created_at,updated_at,opened_at,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`, itemValues(v)...)
}
func (d *DAO) SaveItem(ctx context.Context, v model.AssistantTaskItem, version int64) (bool, error) {
	return d.changed(ctx, "save assistant item", `UPDATE assistant_task_items SET key=$4,state=$5,category=$6,request_fingerprint=$7,episode=$8,version=$9,follower_bot_id=$10,app_state=$11,created_at=$12,updated_at=$13,opened_at=$14,closed_at=$15 WHERE id=$1 AND owner_user_id=$2 AND task_id=$3 AND version=$16`, append(itemValues(v), version)...)
}
func (d *DAO) InsertItemClosure(ctx context.Context, v model.AssistantTaskItemClosure) error {
	return d.execute(ctx, "insert assistant item closure", `INSERT INTO assistant_task_item_closures(id,owner_user_id,task_id,item_id,episode,opened_at,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, v.ID, v.OwnerUserID, v.TaskID, v.ItemID, v.Episode, v.OpenedAt, v.ClosedAt)
}
func (d *DAO) TransferOpenItems(ctx context.Context, owner, task string, follower *string) error {
	return d.execute(ctx, "transfer assistant items", `UPDATE assistant_task_items SET follower_bot_id=$3,version=version+1,updated_at=clock_timestamp() WHERE owner_user_id=$1 AND task_id=$2 AND state='open' AND follower_bot_id IS DISTINCT FROM $3::uuid`, owner, task, follower)
}
