package store

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5"
)

const attachmentMaintenanceLock int64 = 0x444e4154544c4159

type attachmentMaintenanceConnection struct {
	conn   *pgx.Conn
	config *pgx.ConnConfig
}

// OpenAttachmentMaintenance acquires a session lock held until Close. It does
// not fence application writes; all writers must be stopped by the operator.
func OpenAttachmentMaintenance(ctx context.Context, databaseURL string) (AttachmentMaintenance, error) {
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, &AttachmentMaintenanceError{Stage: AttachmentMaintenanceConfig, Cause: err}
	}
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, &AttachmentMaintenanceError{Stage: AttachmentMaintenanceConnect, Cause: err}
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", attachmentMaintenanceLock); err != nil {
		_ = conn.Close(context.Background())
		return nil, &AttachmentMaintenanceError{Stage: AttachmentMaintenanceLock, Cause: err}
	}
	return &attachmentMaintenanceConnection{conn: conn, config: config}, nil
}

func (m *attachmentMaintenanceConnection) Close(ctx context.Context) error { return m.conn.Close(ctx) }

func (m *attachmentMaintenanceConnection) Snapshot(ctx context.Context, visitor AttachmentMaintenanceVisitor) error {
	fail := func(stage AttachmentMaintenanceStage, cause error) error {
		return &AttachmentMaintenanceError{Stage: stage, Cause: cause}
	}
	tx, err := m.conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return fail(AttachmentMaintenanceSnapshotOpen, err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SET LOCAL TIME ZONE 'UTC'"); err != nil {
		return fail(AttachmentMaintenanceSnapshotTimezone, err)
	}
	identity := AttachmentMaintenanceIdentity{Host: m.config.Host, Port: strconv.Itoa(int(m.config.Port)), Relations: map[string]string{}}
	if err := tx.QueryRow(ctx, `SELECT current_database(), current_schema(), (SELECT oid::text FROM pg_database WHERE datname=current_database())`).Scan(&identity.Database, &identity.Schema, &identity.DatabaseOID); err != nil {
		return fail(AttachmentMaintenanceIdentityRead, err)
	}
	for _, name := range []string{"projects", "tasks", "task_attachments"} {
		var schema, oid string
		if err := tx.QueryRow(ctx, `SELECT n.nspname, c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)`, name).Scan(&schema, &oid); err != nil {
			return fail(AttachmentMaintenanceRelationsRead, err)
		}
		identity.Relations[name] = schema + "/" + oid
	}
	if err := visitor.Identity(identity); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id::text, to_jsonb(p)::text FROM projects p ORDER BY id`)
	if err != nil {
		return fail(AttachmentMaintenanceProjectsQuery, err)
	}
	for rows.Next() {
		var project AttachmentMaintenanceProject
		if err := rows.Scan(&project.ID, &project.Data); err != nil {
			rows.Close()
			return fail(AttachmentMaintenanceProjectsDecode, err)
		}
		if err := visitor.Project(project); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fail(AttachmentMaintenanceProjectsRead, err)
	}
	rows, err = tx.Query(ctx, `SELECT id::text, project_id::text, to_jsonb(t)::text FROM tasks t ORDER BY id`)
	if err != nil {
		return fail(AttachmentMaintenanceTasksQuery, err)
	}
	for rows.Next() {
		var owner AttachmentMaintenanceOwner
		if err := rows.Scan(&owner.TaskID, &owner.ProjectID, &owner.Data); err != nil {
			rows.Close()
			return fail(AttachmentMaintenanceTasksDecode, err)
		}
		if err := visitor.Owner(owner); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fail(AttachmentMaintenanceTasksRead, err)
	}
	rows, err = tx.Query(ctx, `SELECT project_id::text, task_id::text, path, size_bytes, to_jsonb(a)::text FROM task_attachments a ORDER BY task_id, path COLLATE "C"`)
	if err != nil {
		return fail(AttachmentMaintenanceMetadataQuery, err)
	}
	for rows.Next() {
		var metadata AttachmentMaintenanceMetadata
		if err := rows.Scan(&metadata.ProjectID, &metadata.TaskID, &metadata.Path, &metadata.SizeBytes, &metadata.Data); err != nil {
			rows.Close()
			return fail(AttachmentMaintenanceMetadataDecode, err)
		}
		if err := visitor.Metadata(metadata); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fail(AttachmentMaintenanceMetadataRead, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fail(AttachmentMaintenanceSnapshotCommit, err)
	}
	return nil
}
