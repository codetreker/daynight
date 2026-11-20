package usage

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func scopeFilter(f store.UsageFilter, alias, sessionColumn string) (string, []any) {
	clauses := []string{"true"}
	args := []any{}
	add := func(c string, v any) {
		args = append(args, v)
		clauses = append(clauses, alias+"."+c+"=$"+strconv.Itoa(len(args)))
	}
	if f.ProjectID != "" {
		add("project_id", f.ProjectID)
	}
	if f.SessionID != "" {
		add(sessionColumn, f.SessionID)
	}
	if f.TaskIDs != nil {
		args = append(args, f.TaskIDs)
		clauses = append(clauses, alias+".task_id=ANY($"+strconv.Itoa(len(args))+"::uuid[])")
	}
	return strings.Join(clauses, " AND "), args
}
func recordFilter(f store.UsageFilter) (string, []any) {
	where, args := scopeFilter(f, "usage_records", "session_id")
	stateColumn := "state_id"
	if f.Kind == "execution_state" {
		stateColumn = "id"
	}
	for _, pair := range [][2]string{{"record_kind", f.Kind}, {stateColumn, f.StateID}, {"model", f.Model}, {"provider", f.Provider}, {"aggregation_role", f.Role}} {
		if pair[1] != "" {
			args = append(args, pair[1])
			where += " AND " + pair[0] + "=$" + strconv.Itoa(len(args))
		}
	}
	return where, args
}
func (d *DAO) Tasks(ctx context.Context, project string, ids []string) ([]store.UsageMember, error) {
	rows, err := d.tx.Query(ctx, `SELECT id::text,title FROM task_resource_rows WHERE project_id=$1 AND id=ANY($2::uuid[]) AND type='task' AND effective_deleted_at IS NULL ORDER BY id`, project, ids)
	if err != nil {
		return nil, pg.QueryError("usage tasks", err)
	}
	defer rows.Close()
	out := []store.UsageMember{}
	for rows.Next() {
		var m store.UsageMember
		if err = rows.Scan(&m.ID, &m.Title); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, queryError("usage tasks", rows.Err())
}
func (d *DAO) Members(ctx context.Context, project, kind, id string, limit int) ([]store.UsageMember, error) {
	targetType := "task"
	if kind == "goal" {
		targetType = "goal"
	}
	var exists bool
	if err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_resource_rows WHERE project_id=$1 AND id=$2 AND type=$3 AND effective_deleted_at IS NULL)`, project, id, targetType).Scan(&exists); err != nil {
		return nil, pg.QueryError("usage aggregate root", err)
	}
	if !exists {
		return nil, model.ErrNotFound
	}
	var query string
	if kind == "goal" {
		query = `SELECT t.id::text,t.title FROM task_resource_rows t WHERE t.project_id=$1 AND t.parent_id=$2 AND t.type='task' AND t.effective_deleted_at IS NULL AND EXISTS(SELECT 1 FROM task_resource_rows g WHERE g.project_id=$1 AND g.id=$2 AND g.type='goal' AND g.effective_deleted_at IS NULL) ORDER BY t.id LIMIT $3`
	} else {
		query = `WITH RECURSIVE members(id) AS (
 SELECT id FROM task_resource_rows WHERE project_id=$1 AND id=$2 AND type='task' AND effective_deleted_at IS NULL
 UNION
 SELECT t.id FROM members m JOIN task_dependencies d ON d.project_id=$1 AND d.dependency_type='task' AND NOT d.external AND (d.task_id=m.id OR d.depends_on_task_id=m.id)
 JOIN task_resource_rows t ON t.project_id=$1 AND t.id=CASE WHEN d.task_id=m.id THEN d.depends_on_task_id ELSE d.task_id END AND t.type='task' AND t.effective_deleted_at IS NULL
) SELECT t.id::text,t.title FROM members m JOIN task_resource_rows t ON t.project_id=$1 AND t.id=m.id ORDER BY t.id LIMIT $3`
	}
	rows, err := d.tx.Query(ctx, query, project, id, limit)
	if err != nil {
		return nil, pg.QueryError("usage members", err)
	}
	defer rows.Close()
	out := []store.UsageMember{}
	for rows.Next() {
		var m store.UsageMember
		if err = rows.Scan(&m.ID, &m.Title); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, queryError("usage members", rows.Err())
}
func (d *DAO) Metrics(ctx context.Context, f store.UsageFilter) (model.UsageSummary, error) {
	where, args := recordFilter(f)
	names := []string{"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens"}
	selects := []string{"count(*)::text", "max(updated_at)"}
	var result model.UsageSummary
	result.Metrics = map[string]model.UsageMetricSummary{}
	values := make([]model.UsageMetricSummary, 6)
	dest := []any{&result.MeasurementRecords, &result.LastMeasuredAt}
	for i, n := range names {
		selects = append(selects, "sum("+n+")::text", "count("+n+")::text", "count(*) FILTER(WHERE "+n+" IS NULL)::text")
		dest = append(dest, &values[i].Known, &values[i].ContributingRecords, &values[i].UnknownRecords)
	}
	err := d.tx.QueryRow(ctx, `SELECT `+strings.Join(selects, ",")+` FROM usage_records WHERE `+where+` AND record_kind='measurement' AND aggregation_role='counted' AND disposition='active'`, args...).Scan(dest...)
	keys := []string{"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"}
	for i, k := range keys {
		result.Metrics[k] = values[i]
	}
	return result, queryError("aggregate usage", err)
}
func (d *DAO) executionStates(ctx context.Context, f store.UsageFilter) ([]store.UsageExecution, error) {
	f.Kind = "execution_state"
	where, args := recordFilter(f)
	args = append(args, f.ObservedAt)
	query := `SELECT id::text,session_id::text,task_id::text,execution_generation::text,
 COALESCE(capability->>'qualification',''),COALESCE(capability->>'measurementPlane',''),
 collection_state,reason_codes,grant_expires_at,grant_revoked_at,sealed_at,
 EXISTS(SELECT 1 FROM personal_access_tokens p JOIN users u ON u.id=p.user_id
 WHERE p.id=usage_records.grant_parent_credential_id AND p.user_id=usage_records.native_authority_user_id
 AND (p.expires_at IS NULL OR p.expires_at>$` + strconv.Itoa(len(args)) + `)),
 EXISTS(SELECT 1 FROM usage_records r WHERE r.session_id=usage_records.session_id AND r.record_kind='measurement' AND r.disposition='active' AND r.aggregation_role='counted' AND (r.input_tokens IS NOT NULL OR r.output_tokens IS NOT NULL OR r.cache_read_tokens IS NOT NULL OR r.cache_write_tokens IS NOT NULL OR r.reasoning_tokens IS NOT NULL OR r.total_tokens IS NOT NULL)),
 EXISTS(SELECT 1 FROM usage_records r WHERE r.session_id=usage_records.session_id AND r.record_kind='measurement' AND r.disposition='active' AND r.aggregation_role='unattributed'),
 EXISTS(SELECT 1 FROM usage_records r WHERE r.session_id=usage_records.session_id AND r.record_kind='measurement' AND r.disposition='active' AND r.aggregation_role='included' AND NOT EXISTS(SELECT 1 FROM usage_records parent WHERE parent.record_kind='measurement' AND parent.native_authority_user_id=r.native_authority_user_id AND parent.provider=r.provider AND parent.native_session_id=r.native_session_id AND parent.source_key=r.included_in_source_key AND parent.aggregation_role='counted' AND parent.disposition='active' AND COALESCE(parent.anchor_state_id,parent.state_id)=COALESCE(r.anchor_state_id,r.state_id)))
 FROM usage_records WHERE ` + where + ` ORDER BY created_at,id`
	rows, err := d.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, pg.QueryError("usage coverage states", err)
	}
	defer rows.Close()
	out := []store.UsageExecution{}
	for rows.Next() {
		var r model.UsageRecord
		var e store.UsageExecution
		var unattributed, missingParent bool
		r.Capability = &model.UsageCapability{}
		if err = rows.Scan(&r.ID, &r.SessionID, &r.TaskID, &r.Generation, &r.Capability.Qualification, &r.Capability.MeasurementPlane, &r.CollectionState, &r.ReasonCodes, &r.GrantExpiresAt, &r.GrantRevokedAt, &r.SealedAt, &e.ParentValid, &e.Known, &unattributed, &missingParent); err != nil {
			return nil, err
		}
		if unattributed {
			e.GapReasons = append(e.GapReasons, "attribution_unknown")
		}
		if missingParent {
			e.GapReasons = append(e.GapReasons, "inclusion_parent_missing")
		}
		e.State = &r
		out = append(out, e)
	}
	return out, queryError("usage coverage states", rows.Err())
}
func (d *DAO) Executions(ctx context.Context, f store.UsageFilter) ([]store.UsageExecution, error) {
	if f.ObservedAt.IsZero() {
		now, err := d.Now(ctx)
		if err != nil {
			return nil, err
		}
		f.ObservedAt = now
	}
	where, args := scopeFilter(f, "s", "id")
	states, err := d.executionStates(ctx, f)
	if err != nil {
		return nil, err
	}
	bySession := map[string][]store.UsageExecution{}
	for i := range states {
		r := states[i]
		bySession[r.State.SessionID] = append(bySession[r.State.SessionID], r)
	}
	args = append(args, f.ObservedAt)
	// The coverage predicates match partial indexes, keeping existence probes
	// bounded without rescanning all measurements or inflating JIT plan costs.
	query := `WITH execution_scope AS MATERIALIZED (
 SELECT s.id,s.backend,s.task_id,s.project_id,s.owner_user_id,s.parent_credential_id,s.scope,
 COALESCE(s.snapshot->>'executionGeneration','1') AS current_generation,
 COALESCE(s.snapshot->>'lifecycle','') IN ('archived','stopped','closed','ended') AS stopped
 FROM task_sessions s WHERE ` + where + ` AND s.bot_id IS NULL
)
 SELECT s.id::text,s.backend,s.task_id::text,s.current_generation,
 EXISTS(SELECT 1 FROM personal_access_tokens p JOIN users u ON u.id=p.user_id WHERE p.id=s.parent_credential_id AND p.user_id=s.owner_user_id AND (p.expires_at IS NULL OR p.expires_at>$` + strconv.Itoa(len(args)) + `)),
 CASE WHEN s.scope='test' THEN true ELSE EXISTS(SELECT 1 FROM task_resource_rows t JOIN (` + pg.ProjectAccessRelation + `) a ON a.project_id=t.project_id AND a.user_id=s.owner_user_id WHERE t.id=s.task_id AND t.project_id=s.project_id AND t.effective_deleted_at IS NULL AND t.allow_agents AND NOT EXISTS(SELECT 1 FROM task_properties p WHERE p.task_id=t.id AND CASE WHEN p.name='blocked' THEN p.value::jsonb='true'::jsonb ELSE false END)) END,
 s.stopped,
 EXISTS(SELECT 1 FROM usage_records r WHERE r.session_id=s.id AND r.record_kind='measurement' AND r.disposition='active' AND r.aggregation_role='counted' AND (r.input_tokens IS NOT NULL OR r.output_tokens IS NOT NULL OR r.cache_read_tokens IS NOT NULL OR r.cache_write_tokens IS NOT NULL OR r.reasoning_tokens IS NOT NULL OR r.total_tokens IS NOT NULL)),
 EXISTS(SELECT 1 FROM usage_records r WHERE r.session_id=s.id AND r.record_kind='measurement' AND r.disposition='active' AND r.aggregation_role='unattributed'),
 EXISTS(SELECT 1 FROM usage_records r WHERE r.session_id=s.id AND r.record_kind='measurement' AND r.disposition='active' AND r.aggregation_role='included' AND NOT EXISTS(SELECT 1 FROM usage_records parent WHERE parent.record_kind='measurement' AND parent.native_authority_user_id=r.native_authority_user_id AND parent.provider=r.provider AND parent.native_session_id=r.native_session_id AND parent.source_key=r.included_in_source_key AND parent.aggregation_role='counted' AND parent.disposition='active' AND COALESCE(parent.anchor_state_id,parent.state_id)=COALESCE(r.anchor_state_id,r.state_id)))
 FROM execution_scope s ORDER BY s.id`
	rows, err := d.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, pg.QueryError("usage coverage", err)
	}
	defer rows.Close()
	out := []store.UsageExecution{}
	for rows.Next() {
		var e store.UsageExecution
		var currentGeneration string
		var unattributed, missingParent bool
		if err = rows.Scan(&e.SessionID, &e.Backend, &e.TaskID, &currentGeneration, &e.ParentValid, &e.Allowed, &e.Stopped, &e.Known, &unattributed, &missingParent); err != nil {
			return nil, err
		}
		if unattributed {
			e.GapReasons = append(e.GapReasons, "attribution_unknown")
		}
		if missingParent {
			e.GapReasons = append(e.GapReasons, "inclusion_parent_missing")
		}
		runs := bySession[e.SessionID]
		if len(runs) == 0 {
			out = append(out, e)
		} else {
			registeredCurrent := false
			for _, run := range runs {
				r := run.State
				registeredCurrent = registeredCurrent || r.Generation == currentGeneration
				copy := e
				copy.State = r
				copy.ParentValid = run.ParentValid
				// Publishing a later generation requires the original controller's stop proof.
				copy.Stopped = e.Stopped || r.Generation != currentGeneration
				out = append(out, copy)
			}
			if !registeredCurrent {
				out = append(out, e)
			}
		}
		delete(bySession, e.SessionID)
	}
	for _, runs := range bySession {
		for _, run := range runs {
			run.SessionID = run.State.SessionID
			run.TaskID = run.State.TaskID
			out = append(out, run)
		}
	}
	return out, queryError("usage coverage", rows.Err())
}
func (d *DAO) Revision(ctx context.Context, f store.UsageFilter) (store.UsageRevision, error) {
	where, args := recordFilter(f)
	var r store.UsageRevision
	err := d.tx.QueryRow(ctx, `SELECT count(*)::text,max(updated_at),encode(sha256(convert_to(COALESCE(string_agg(id::text||':'||row_version::text,',' ORDER BY id),''),'UTF8')),'hex') FROM usage_records WHERE `+where, args...).Scan(&r.Count, &r.UpdatedAt, &r.Hash)
	return r, queryError("usage revision", err)
}
func recordsQuery(f store.UsageFilter, columns string) (string, []any) {
	where, args := recordFilter(f)
	if f.AfterTime != nil {
		args = append(args, *f.AfterTime, f.AfterID)
		where += fmt.Sprintf(" AND (created_at,id)>($%d,$%d::uuid)", len(args)-1, len(args))
	}
	query := `SELECT ` + columns + ` FROM usage_records WHERE ` + where + ` ORDER BY created_at,id`
	if f.Limit > 0 {
		args = append(args, f.Limit)
		query += " LIMIT $" + strconv.Itoa(len(args))
	}
	return query, args
}
func (d *DAO) Records(ctx context.Context, f store.UsageFilter) ([]model.UsageRecord, error) {
	query, args := recordsQuery(f, selection())
	rows, err := d.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, pg.QueryError("usage records", err)
	}
	defer rows.Close()
	out := []model.UsageRecord{}
	for rows.Next() {
		r, e := scan(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, queryError("usage records", rows.Err())
}

func (d *DAO) TaskMetrics(ctx context.Context, f store.UsageFilter) (map[string]model.UsageSummary, error) {
	where, args := recordFilter(f)
	selects := []string{"task_id::text", "count(*)::text", "max(updated_at)"}
	names := []string{"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens"}
	keys := []string{"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"}
	for _, n := range names {
		selects = append(selects, "sum("+n+")::text", "count("+n+")::text", "count(*) FILTER(WHERE "+n+" IS NULL)::text")
	}
	rows, err := d.tx.Query(ctx, `SELECT `+strings.Join(selects, ",")+` FROM usage_records WHERE `+where+` AND record_kind='measurement' AND aggregation_role='counted' AND disposition='active' GROUP BY task_id`, args...)
	if err != nil {
		return nil, pg.QueryError("batch usage totals", err)
	}
	defer rows.Close()
	out := map[string]model.UsageSummary{}
	for rows.Next() {
		var id string
		var r model.UsageSummary
		values := make([]model.UsageMetricSummary, 6)
		dest := []any{&id, &r.MeasurementRecords, &r.LastMeasuredAt}
		for i := range values {
			dest = append(dest, &values[i].Known, &values[i].ContributingRecords, &values[i].UnknownRecords)
		}
		if err = rows.Scan(dest...); err != nil {
			return nil, err
		}
		r.Metrics = map[string]model.UsageMetricSummary{}
		for i, k := range keys {
			r.Metrics[k] = values[i]
		}
		out[id] = r
	}
	return out, queryError("batch usage totals", rows.Err())
}
