package maintenance

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

const inputCandidateBytes int64 = 8 << 20

type inputLimitsConnection struct {
	conn   *pgx.Conn
	config *pgx.ConnConfig
}

// OpenInputLimits opens a dedicated offline connection. Operators must stop all
// database and file writers; a snapshot alone cannot establish that condition.
func OpenInputLimits(ctx context.Context, databaseURL string) (store.InputLimitsSnapshot, error) {
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("input limits configuration: %w", err)
	}
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("input limits connection: %w", err)
	}
	return &inputLimitsConnection{conn: conn, config: config}, nil
}

func (c *inputLimitsConnection) Close(ctx context.Context) error { return c.conn.Close(ctx) }

type inputColumn struct {
	name, expression string
	hash             bool
}
type inputProjection struct {
	kind, from, order string
	ids, fields       []inputColumn
}

func col(name, expression string) inputColumn { return inputColumn{name: name, expression: expression} }
func key(name, expression string) inputColumn {
	return inputColumn{name: name, expression: expression, hash: true}
}

// inputProjections deliberately name columns rather than serializing complete
// rows. Their candidate is made available only when all selected values fit.
var inputProjections = []inputProjection{
	{kind: "property", from: "task_properties p", order: "p.task_id,p.name COLLATE \"C\"", ids: []inputColumn{col("taskId", "p.task_id::text")}, fields: []inputColumn{key("name", "p.name"), col("value", "p.value")}},
	{kind: "step", from: "task_steps s LEFT JOIN tasks t ON t.id=s.task_id", order: "s.task_id,s.position", ids: []inputColumn{col("projectId", "coalesce(t.project_id::text,'')"), col("taskId", "s.task_id::text"), col("id", "s.id")}, fields: []inputColumn{col("version", "t.version::text"), col("deletedAt", "t.deleted_at::text"), col("position", "s.position::text"), col("status", "s.status"), col("createdAt", "s.created_at::text"), col("updatedAt", "s.updated_at::text"), col("title", "s.title"), col("description", "s.description")}},
	{kind: "project", from: "projects p", order: "p.id", ids: []inputColumn{col("id", "p.id::text")}, fields: []inputColumn{col("name", "p.name"), col("repoUrl", "p.repo_url"), col("deletedAt", "p.deleted_at::text")}},
	{kind: "team", from: "teams t", order: "t.id", ids: []inputColumn{col("id", "t.id::text")}, fields: []inputColumn{col("personalUserId", "t.personal_user_id::text"), col("name", "t.name")}},
	{kind: "profile", from: "users u LEFT JOIN teams t ON t.personal_user_id=u.id", order: "u.id", ids: []inputColumn{col("id", "u.id::text")}, fields: []inputColumn{col("identityId", "u.uniauth_id"), col("email", "u.email"), col("emailVerified", "u.email_verified::text"), col("name", "u.name"), col("avatarUrl", "u.avatar_url"), col("personalTeamId", "t.id::text"), col("personalTeamName", "t.name")}},
	{kind: "worker", from: "workers w", order: "w.user_id,w.worker_id", ids: []inputColumn{col("userId", "w.user_id::text"), col("workerId", "w.worker_id::text")}, fields: []inputColumn{col("createdAt", "w.created_at::text"), col("lastSeenAt", "w.last_seen_at::text"), col("telemetry", "w.telemetry::text"), col("taskSnapshot", "w.task_snapshot::text")}},
	{kind: "workerConfig", from: "workers w", order: "w.user_id,w.worker_id", ids: []inputColumn{col("userId", "w.user_id::text"), col("workerId", "w.worker_id::text")}, fields: []inputColumn{col("revision", "w.configuration_revision::text"), col("updatedAt", "w.configuration_updated_at::text"), col("desired", "w.desired_configuration::text"), col("observationRevision", "w.configuration_observation_revision::text"), col("observation", "w.configuration_observation::text")}},
	{kind: "attachment", from: "task_attachments a", order: "a.task_id,a.path COLLATE \"C\"", ids: []inputColumn{col("projectId", "a.project_id::text"), col("taskId", "a.task_id::text")}, fields: []inputColumn{key("path", "a.path"), col("contentType", "a.content_type"), col("sizeBytes", "a.size_bytes::text")}},
	{kind: "archive", from: "session_archives a LEFT JOIN task_sessions s ON s.id=a.session_id", order: "a.session_id", ids: []inputColumn{col("sessionId", "a.session_id::text")}, fields: []inputColumn{col("state", "a.state"), key("objectPath", "a.object_path"), col("byteLength", "a.byte_length::text"), col("scope", "s.scope"), col("projectId", "s.project_id::text"), col("ownerUserId", "s.owner_user_id::text")}},
	{kind: "transfer", from: "private_transfers x", order: "x.id", ids: []inputColumn{col("id", "x.id::text"), col("userId", "x.user_id::text"), col("projectId", "x.project_id::text"), col("taskId", "x.task_id::text")}, fields: []inputColumn{col("direction", "x.direction"), col("state", "x.state"), key("path", "x.path"), col("contentType", "x.content_type"), col("data", "x.data::text"), col("reservedBytes", "x.reserved_bytes::text"), col("outstandingBytes", "x.outstanding_bytes::text"), col("chunkCount", "(SELECT count(*)::text FROM private_upload_chunks c WHERE c.transfer_id=x.id)"), col("chunkBytes", "(SELECT coalesce(sum(c.byte_size),0)::text FROM private_upload_chunks c WHERE c.transfer_id=x.id)")}},
	{kind: "transferChunk", from: "private_upload_chunks x JOIN private_transfers t ON t.id=x.transfer_id", order: "x.transfer_id,x.chunk_id", ids: []inputColumn{col("transferId", "x.transfer_id::text"), col("chunkId", "x.chunk_id::text"), col("objectId", "x.object_id::text")}, fields: []inputColumn{col("sizeBytes", "x.byte_size::text"), col("offset", "x.byte_offset::text"), col("state", "t.state"), col("direction", "t.direction")}},
	{kind: "orphanProperty", from: "task_properties p LEFT JOIN tasks t ON t.id=p.task_id WHERE t.id IS NULL", order: "p.task_id,p.name COLLATE \"C\"", ids: []inputColumn{col("taskId", "p.task_id::text")}, fields: []inputColumn{key("name", "p.name")}},
	{kind: "orphanDependency", from: "task_dependencies d LEFT JOIN tasks t ON t.id=d.task_id AND t.project_id=d.project_id WHERE t.id IS NULL", order: "d.project_id,d.task_id,d.depends_on_task_id", ids: []inputColumn{col("projectId", "d.project_id::text"), col("taskId", "d.task_id::text"), col("dependencyId", "d.depends_on_task_id::text")}},
	{kind: "orphanAttachment", from: "task_attachments a LEFT JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id WHERE t.id IS NULL", order: "a.task_id,a.path COLLATE \"C\"", ids: []inputColumn{col("projectId", "a.project_id::text"), col("taskId", "a.task_id::text")}, fields: []inputColumn{key("path", "a.path")}},
	{kind: "login", from: "login_transactions l", order: "l.id", ids: []inputColumn{col("id", "l.id::text")}, fields: []inputColumn{col("returnPath", "l.return_path"), col("expiresAt", "l.expires_at::text")}},
}

// projectionSQL only exposes lengths and a tightly bounded locator in its
// cursor. FETCH 1 prevents pgx from pre-reading another metadata item.
func projectionSQL(p inputProjection) string {
	alias := strings.Fields(p.from)[1]
	parts := []string{alias + ".ctid::text"}
	for _, id := range p.ids {
		parts = append(parts, id.expression)
	}
	for _, field := range p.fields {
		e := field.expression
		parts = append(parts, "("+e+") IS NOT NULL", "coalesce(octet_length("+e+"),0)::bigint", "coalesce(char_length("+e+"),0)::bigint")
		if field.hash {
			// These locator limits ensure worst-case JSON escaping fits 8 KiB.
			parts = append(parts, "CASE WHEN octet_length("+e+") <= 4096 AND char_length("+e+") <= 1024 THEN ("+e+") ELSE NULL END", "CASE WHEN ("+e+") IS NOT NULL THEN encode(sha256(convert_to(("+e+"),'UTF8')),'hex') ELSE '' END")
		}
	}
	return "SELECT " + strings.Join(parts, ",") + " FROM " + p.from + " ORDER BY " + p.order
}

// candidateSQL independently enforces the raw budget in SQL, after the length
// observation and before projection. A physical tuple locator is valid within
// this same repeatable-read transaction, including concurrent writer snapshots.
func candidateSQL(p inputProjection) string {
	alias := strings.Fields(p.from)[1]
	lengths := make([]string, 0, len(p.ids)+len(p.fields))
	for _, id := range p.ids {
		lengths = append(lengths, "coalesce(octet_length("+id.expression+"),0)::bigint")
	}
	parts := make([]string, 0, len(p.fields))
	for _, field := range p.fields {
		parts = append(parts, field.expression)
		lengths = append(lengths, "coalesce(octet_length("+field.expression+"),0)::bigint")
	}
	if len(parts) == 0 {
		parts = append(parts, "true")
	}
	predicate := " WHERE "
	if strings.Contains(p.from, " WHERE ") {
		predicate = " AND "
	}
	return "SELECT " + strings.Join(parts, ",") + " FROM " + p.from + predicate + alias + ".ctid=$1::tid AND (" + strings.Join(lengths, "+") + ") <= $2 LIMIT 1"
}

func scanProjection(ctx context.Context, tx pgx.Tx, visitor store.InputLimitsVisitor, p inputProjection) (result error) {
	if _, err := tx.Exec(ctx, "DECLARE input_limits_metadata NO SCROLL CURSOR FOR "+projectionSQL(p)); err != nil {
		return fmt.Errorf("input limits %s metadata cursor: %w", p.kind, err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := tx.Exec(cleanupCtx, "CLOSE input_limits_metadata"); err != nil {
			result = errors.Join(result, fmt.Errorf("input limits %s cursor cleanup: %w", p.kind, err))
		}
	}()
	for {
		var locator string
		ids := make([]string, len(p.ids))
		fields := make([]store.InputLimitsField, len(p.fields))
		args := make([]any, 0, 1+len(ids)+len(fields)*5)
		args = append(args, &locator)
		for i := range ids {
			args = append(args, &ids[i])
		}
		for i, f := range p.fields {
			v := &fields[i]
			args = append(args, &v.Present, &v.Bytes, &v.Characters)
			if f.hash {
				args = append(args, &v.Value, &v.SHA256)
			}
		}
		err := tx.QueryRow(ctx, "FETCH FORWARD 1 FROM input_limits_metadata /* "+p.kind+" */").Scan(args...)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return fmt.Errorf("input limits %s metadata: %w", p.kind, err)
		}
		record := store.InputLimitsRecord{Kind: p.kind, IDs: map[string]string{}, Fields: map[string]store.InputLimitsField{}, Numbers: map[string]int64{}}
		var total int64
		for i, id := range p.ids {
			record.IDs[id.name] = ids[i]
			total += int64(len(ids[i]))
		}
		for _, v := range fields {
			if v.Bytes > inputCandidateBytes-total {
				total = inputCandidateBytes + 1
				break
			}
			total += v.Bytes
		}
		record.CandidateComplete = total <= inputCandidateBytes
		if record.CandidateComplete {
			values := make([]*string, len(fields))
			var marker bool
			dest := make([]any, 0, len(fields))
			for i := range values {
				dest = append(dest, &values[i])
			}
			if len(dest) == 0 {
				dest = append(dest, &marker)
			}
			if err := tx.QueryRow(ctx, candidateSQL(p), locator, inputCandidateBytes).Scan(dest...); err != nil {
				return fmt.Errorf("input limits %s candidate: %w", p.kind, err)
			}
			for i, value := range values {
				if fields[i].Present != (value != nil) || value != nil && int64(len(*value)) != fields[i].Bytes {
					return fmt.Errorf("input limits %s candidate changed", p.kind)
				}
				fields[i].Value = value
			}
		}
		for i, f := range p.fields {
			record.Fields[f.name] = fields[i]
		}
		if err := visitor.Record(record); err != nil {
			return err
		}
	}
}

func (c *inputLimitsConnection) Scan(ctx context.Context, visitor store.InputLimitsVisitor) (result error) {
	tx, err := c.conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return fmt.Errorf("input limits snapshot: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanupCtx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			result = errors.Join(result, fmt.Errorf("input limits rollback: %w", err))
		}
	}()
	if _, err = tx.Exec(ctx, "SET LOCAL TIME ZONE 'UTC'"); err != nil {
		return fmt.Errorf("input limits timezone: %w", err)
	}
	identity := store.InputLimitsIdentity{Host: c.config.Host, Port: strconv.Itoa(int(c.config.Port)), Relations: map[string]string{}}
	if err = tx.QueryRow(ctx, `SELECT current_database(),current_schema(),(SELECT oid::text FROM pg_database WHERE datname=current_database()),pg_current_snapshot()::text,statement_timestamp(),coalesce(host(inet_server_addr()),'unix'),coalesce(inet_server_port()::text,'unix'),(pg_control_system()).system_identifier::text`).Scan(&identity.Database, &identity.Schema, &identity.DatabaseOID, &identity.Snapshot, &identity.ObservedAt, &identity.ServerAddress, &identity.ServerPort, &identity.SystemIdentifier); err != nil {
		return fmt.Errorf("input limits identity: %w", err)
	}
	for _, name := range []string{"tasks", "task_properties", "task_dependencies", "task_steps", "projects", "teams", "users", "workers", "task_attachments", "session_archives", "task_sessions", "private_transfers", "private_upload_chunks", "login_transactions"} {
		var schema, oid string
		if err = tx.QueryRow(ctx, `SELECT n.nspname,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)`, name).Scan(&schema, &oid); err != nil {
			return fmt.Errorf("input limits relation %s: %w", name, err)
		}
		identity.Relations[name] = schema + "/" + oid
	}
	if err = visitor.Identity(identity); err != nil {
		return err
	}
	if err = scanInputTasks(ctx, tx, visitor); err != nil {
		return err
	}
	for _, p := range inputProjections {
		if err = scanProjection(ctx, tx, visitor, p); err != nil {
			return err
		}
	}
	if err = scanActiveOwners(ctx, tx, visitor, identity.ObservedAt); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("input limits commit: %w", err)
	}
	return nil
}
