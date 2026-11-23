package usage

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type DAO struct{ tx pgx.Tx }

func queryError(phase string, err error) error {
	if err == nil {
		return nil
	}
	return pg.QueryError(phase, err)
}

func New(tx pgx.Tx) store.UsageDAO { return &DAO{tx: tx} }

func (d *DAO) Now(ctx context.Context) (time.Time, error) {
	var t time.Time
	err := d.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&t)
	return t.UTC(), queryError("usage time", err)
}
func (d *DAO) Session(ctx context.Context, id string) (store.UsageSession, error) {
	var s store.UsageSession
	var parent, connection *string
	err := d.tx.QueryRow(ctx, `SELECT id::text,scope,backend,owner_user_id::text,parent_credential_id::text,connection_parent_credential_id::text,project_id::text,task_id::text,claim_id::text,test_execution_id::text,created_at,bot_id::text FROM task_sessions WHERE id=$1`, id).Scan(&s.ID, &s.Scope, &s.Backend, &s.OwnerID, &parent, &connection, &s.ProjectID, &s.TaskID, &s.ClaimID, &s.TestExecutionID, &s.CreatedAt, &s.BotID)
	s.ParentID = core.Value(parent)
	s.ConnectionParentID = core.Value(connection)
	s.CreatedAt = s.CreatedAt.UTC()
	return s, queryError("usage session", err)
}
func (d *DAO) LockTask(ctx context.Context, s store.UsageSession) (store.UsageAuthorization, error) {
	return d.task(ctx, s, true)
}
func (d *DAO) ReadTask(ctx context.Context, s store.UsageSession) (store.UsageAuthorization, error) {
	return d.task(ctx, s, false)
}
func (d *DAO) task(ctx context.Context, s store.UsageSession, lock bool) (store.UsageAuthorization, error) {
	var a store.UsageAuthorization
	if s.Scope != "task" {
		return a, nil
	}
	if lock {
		presence, err := pg.LockTaskResource(ctx, d.tx, *s.ProjectID, *s.TaskID, false)
		if err != nil {
			return a, err
		}
		if !presence.Found || presence.DeletedAt != nil {
			return a, model.ErrNotFound
		}
	}
	err := d.tx.QueryRow(ctx, `SELECT type,allow_agents FROM task_resource_rows WHERE project_id=$1 AND id=$2 AND effective_deleted_at IS NULL`, s.ProjectID, s.TaskID).Scan(&a.TaskType, &a.AllowAgents)
	if err != nil {
		return a, pg.QueryError("usage task", err)
	}
	rows, err := d.tx.Query(ctx, `SELECT name,value FROM task_properties WHERE task_id=$1 AND name IN ('worker','blocked')`, s.TaskID)
	if err != nil {
		return a, pg.QueryError("usage task properties", err)
	}
	properties := model.TaskProperties{}
	for rows.Next() {
		var name string
		var raw []byte
		if err = rows.Scan(&name, &raw); err != nil {
			break
		}
		properties[name] = json.RawMessage(raw)
	}
	rows.Close()
	if err != nil {
		return a, err
	}
	if err = rows.Err(); err != nil {
		return a, err
	}
	w, err := taskproperty.Worker(properties)
	if err != nil {
		return a, err
	}
	if w != nil {
		a.ClaimActive = w.ClaimID == core.Value(s.ClaimID) && w.State == model.WorkerActive && w.UserID == s.OwnerID && w.AgentControlMode == model.AgentControlModeWeb
		a.WorkerID = core.Ptr(w.WorkerID)
	}
	if raw, ok := properties["blocked"]; ok {
		if err = json.Unmarshal(raw, &a.Paused); err != nil {
			return a, err
		}
	}
	return a, nil
}
func (d *DAO) ProjectAccess(ctx context.Context, user, project string, lock bool) (model.ProjectAccess, error) {
	if lock {
		return pg.LockProjectAuthorization(ctx, d.tx, user, project)
	}
	return pg.ReadProjectAccess(ctx, d.tx, user, project)
}
func (d *DAO) ProjectPresent(ctx context.Context, project string) (bool, error) {
	var present bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND deleted_at IS NULL)`, project).Scan(&present)
	return present, queryError("usage project presence", err)
}
func (d *DAO) PermissionEpoch(ctx context.Context, user, project string) (string, error) {
	var epoch string
	err := d.tx.QueryRow(ctx, `SELECT jsonb_build_array(o.version::text,m.version::text,g.version::text)::text FROM project_ownership o LEFT JOIN team_members m ON m.team_id=o.team_id AND m.user_id=$2 LEFT JOIN project_grants g ON g.project_id=o.project_id AND g.user_id=$2 WHERE o.project_id=$1`, project, user).Scan(&epoch)
	return epoch, queryError("usage permission epoch", err)
}
func (d *DAO) ParentValid(ctx context.Context, id, user string, lock bool) (bool, error) {
	suffix := ""
	if lock {
		suffix = " FOR SHARE OF p,u"
	}
	var ignored string
	err := d.tx.QueryRow(ctx, `SELECT p.id::text FROM personal_access_tokens p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.user_id=$2 AND (p.expires_at IS NULL OR p.expires_at>clock_timestamp())`+suffix, id, user).Scan(&ignored)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if lock && err == nil {
		var valid bool
		err = d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM personal_access_tokens WHERE id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>clock_timestamp()))`, id, user).Scan(&valid)
		return valid, queryError("recheck usage parent expiry", err)
	}
	return err == nil, queryError("usage parent", err)
}

const columns = `id,record_kind,scope,project_id,task_id,test_execution_id,session_id,claim_id,execution_generation,worker_id,native_authority_user_id,provider,native_session_id,state_id,anchor_state_id,registration_id,source_key,native_turn_id,native_call_id,model,profile_id,provider_version,revision_authority,source_revision,finality,disposition,aggregation_role,included_in_source_key,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,provider_total_tokens,native_metrics,capability,collection_state,reason_codes,state_sequence,grant_hash,grant_parent_credential_id,grant_expires_at,grant_revoked_at,sealed_at,native_started_at,native_ended_at,observed_at,created_at,updated_at,row_version,body_hash`

var textColumns = map[string]bool{}

func init() {
	for _, s := range strings.Split("id,project_id,task_id,test_execution_id,session_id,claim_id,execution_generation,worker_id,native_authority_user_id,state_id,anchor_state_id,registration_id,source_revision,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,provider_total_tokens,state_sequence,grant_parent_credential_id,row_version", ",") {
		textColumns[s] = true
	}
}
func selection() string {
	out := strings.Split(columns, ",")
	for i, s := range out {
		if textColumns[s] {
			out[i] = s + "::text"
		}
	}
	return strings.Join(out, ",")
}

type scanner interface{ Scan(...any) error }

func scan(row scanner) (model.UsageRecord, error) {
	var r model.UsageRecord
	var native, capability, reasons, hash []byte
	var start, end *time.Time
	err := row.Scan(&r.ID, &r.Kind, &r.Scope, &r.ProjectID, &r.TaskID, &r.TestExecutionID, &r.SessionID, &r.ClaimID, &r.Generation, &r.WorkerID, &r.AuthorityUserID, &r.Provider, &r.NativeSessionID, &r.StateID, &r.AnchorStateID, &r.RegistrationID, &r.SourceKey, &r.NativeTurnID, &r.NativeCallID, &r.Model, &r.ProfileID, &r.ProviderVersion, &r.RevisionAuthority, &r.SourceRevision, &r.Finality, &r.Disposition, &r.AggregationRole, &r.IncludedInSourceKey, &r.Metrics.Input, &r.Metrics.Output, &r.Metrics.CacheRead, &r.Metrics.CacheWrite, &r.Metrics.Reasoning, &r.Metrics.Total, &r.Metrics.ProviderTotal, &native, &capability, &r.CollectionState, &reasons, &r.StateSequence, &r.GrantHash, &r.ParentCredentialID, &r.GrantExpiresAt, &r.GrantRevokedAt, &r.SealedAt, &start, &end, &r.ObservedAt, &r.CreatedAt, &r.UpdatedAt, &r.RowVersion, &hash)
	if err != nil {
		return r, pg.QueryError("read usage", err)
	}
	r.BodyHash = hex.EncodeToString(hash)
	r.ObservedAt = r.ObservedAt.UTC()
	r.CreatedAt = r.CreatedAt.UTC()
	r.UpdatedAt = r.UpdatedAt.UTC()
	for _, p := range []*time.Time{r.GrantExpiresAt, r.GrantRevokedAt, r.SealedAt} {
		if p != nil {
			*p = p.UTC()
		}
	}
	for _, v := range []struct {
		raw    []byte
		target any
	}{{native, &r.NativeMetrics}, {capability, &r.Capability}, {reasons, &r.ReasonCodes}} {
		if len(v.raw) > 0 {
			if err = json.Unmarshal(v.raw, v.target); err != nil {
				return r, fmt.Errorf("decode usage: %w", err)
			}
		}
	}
	if start != nil {
		r.NativeStartedAt = core.Ptr(start.UTC().Format(time.RFC3339Nano))
	}
	if end != nil {
		r.NativeEndedAt = core.Ptr(end.UTC().Format(time.RFC3339Nano))
	}
	if !core.Sequence(r.RowVersion, false) || len(hash) != 32 {
		return r, fmt.Errorf("invalid persisted usage identity")
	}
	if r.Kind == "execution_state" {
		if _, err = core.ParseGrantVerifier(r.GrantHash); err != nil {
			return r, fmt.Errorf("read usage grant verifier: %w", err)
		}
	}
	return r, nil
}
func (d *DAO) State(ctx context.Context, id string) (model.UsageRecord, error) {
	return scan(d.tx.QueryRow(ctx, `SELECT `+selection()+` FROM usage_records WHERE id=$1 AND record_kind='execution_state'`, id))
}
func (d *DAO) Generation(ctx context.Context, id, generation string) (model.UsageRecord, error) {
	return scan(d.tx.QueryRow(ctx, `SELECT `+selection()+` FROM usage_records WHERE session_id=$1 AND execution_generation=$2::text::bigint AND record_kind='execution_state'`, id, generation))
}
func (d *DAO) Anchor(ctx context.Context, user, provider, native string) (model.UsageRecord, error) {
	return scan(d.tx.QueryRow(ctx, `SELECT `+selection()+` FROM usage_records WHERE native_authority_user_id=$1 AND provider=$2 AND native_session_id=$3 AND record_kind='execution_state' AND anchor_state_id IS NULL`, user, provider, native))
}
func (d *DAO) Source(ctx context.Context, s model.UsageRecord, key string) (model.UsageRecord, error) {
	return scan(d.tx.QueryRow(ctx, `SELECT `+selection()+` FROM usage_records WHERE native_authority_user_id=$1 AND provider=$2 AND native_session_id=$3 AND source_key=$4 AND record_kind='measurement'`, s.AuthorityUserID, s.Provider, s.NativeSessionID, key))
}
func arguments(r model.UsageRecord) []any {
	return []any{r.ID, r.Kind, r.Scope, r.ProjectID, r.TaskID, r.TestExecutionID, r.SessionID, r.ClaimID, r.Generation, r.WorkerID, r.AuthorityUserID, r.Provider, r.NativeSessionID, r.StateID, r.AnchorStateID, r.RegistrationID, r.SourceKey, r.NativeTurnID, r.NativeCallID, r.Model, r.ProfileID, r.ProviderVersion, r.RevisionAuthority, r.SourceRevision, r.Finality, r.Disposition, r.AggregationRole, r.IncludedInSourceKey, r.Metrics.Input, r.Metrics.Output, r.Metrics.CacheRead, r.Metrics.CacheWrite, r.Metrics.Reasoning, r.Metrics.Total, r.Metrics.ProviderTotal, jsonValue(r.NativeMetrics), jsonValue(r.Capability), r.CollectionState, jsonValue(r.ReasonCodes), r.StateSequence, r.GrantHash, r.ParentCredentialID, r.GrantExpiresAt, r.GrantRevokedAt, r.SealedAt, r.NativeStartedAt, r.NativeEndedAt, r.ObservedAt, r.CreatedAt, r.UpdatedAt, r.RowVersion, core.HashBytes(r.BodyHash)}
}
func jsonValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		if x == nil {
			return nil
		}
	case *model.UsageCapability:
		if x == nil {
			return nil
		}
	case []string:
		if x == nil {
			return nil
		}
	}
	b, _ := json.Marshal(v)
	return b
}
func placeholder(i int, c string) string {
	p := "$" + strconv.Itoa(i)
	switch c {
	case "execution_generation", "source_revision", "state_sequence", "row_version":
		return p + "::text::bigint"
	case "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "provider_total_tokens":
		return p + "::text::numeric"
	case "native_started_at", "native_ended_at":
		return p + "::text::timestamptz"
	}
	return p
}
func writeError(err error) error {
	if err == nil {
		return nil
	}
	var p *pgconn.PgError
	if errors.As(err, &p) && p.Code == "23505" {
		return core.Fault("usage_changed")
	}
	return pg.QueryError("write usage", err)
}
func (d *DAO) Insert(ctx context.Context, r model.UsageRecord) error {
	names := strings.Split(columns, ",")
	p := make([]string, len(names))
	for i, c := range names {
		p[i] = placeholder(i+1, c)
	}
	_, err := d.tx.Exec(ctx, `INSERT INTO usage_records (`+columns+`) VALUES (`+strings.Join(p, ",")+`)`, arguments(r)...)
	return writeError(err)
}
func (d *DAO) Replace(ctx context.Context, r model.UsageRecord, expected string) error {
	names := strings.Split(columns, ",")
	p := make([]string, 0, len(names)-1)
	for i, c := range names {
		if i > 0 {
			p = append(p, c+"="+placeholder(i+1, c))
		}
	}
	args := append(arguments(r), expected)
	tag, err := d.tx.Exec(ctx, `UPDATE usage_records SET `+strings.Join(p, ",")+` WHERE id=$1 AND row_version=$53::text::bigint`, args...)
	if err != nil {
		return writeError(err)
	}
	if tag.RowsAffected() != 1 {
		return core.Fault("usage_changed")
	}
	return nil
}
func (d *DAO) Guard(ctx context.Context, r model.UsageRecord) error {
	var version string
	err := d.tx.QueryRow(ctx, `SELECT row_version::text FROM usage_records WHERE id=$1 AND row_version=$2::text::bigint AND grant_hash=$3 AND grant_revoked_at IS NULL AND grant_expires_at>clock_timestamp() FOR SHARE`, r.ID, r.RowVersion, r.GrantHash).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return core.Fault("usage_changed")
	}
	return queryError("guard usage grant", err)
}
