package maintenance

import (
	"context"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

const attachmentMaintenanceLock int64 = 0x444e4154544c4159

type attachmentMaintenanceConnection struct {
	conn   *pgx.Conn
	config *pgx.ConnConfig
}

// OpenAttachmentMaintenance acquires a session lock held until Close. It does
// not fence application writes; all writers must be stopped by the operator.
func OpenAttachmentMaintenance(ctx context.Context, databaseURL string) (store.AttachmentMaintenance, error) {
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, &store.AttachmentMaintenanceError{Stage: store.AttachmentMaintenanceConfig, Cause: err}
	}
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, &store.AttachmentMaintenanceError{Stage: store.AttachmentMaintenanceConnect, Cause: err}
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", attachmentMaintenanceLock); err != nil {
		_ = conn.Close(context.Background())
		return nil, &store.AttachmentMaintenanceError{Stage: store.AttachmentMaintenanceLock, Cause: err}
	}
	return &attachmentMaintenanceConnection{conn: conn, config: config}, nil
}

func (m *attachmentMaintenanceConnection) Close(ctx context.Context) error { return m.conn.Close(ctx) }

func (m *attachmentMaintenanceConnection) Snapshot(ctx context.Context, visitor store.AttachmentMaintenanceVisitor) error {
	fail := func(stage store.AttachmentMaintenanceStage, cause error) error {
		return &store.AttachmentMaintenanceError{Stage: stage, Cause: cause}
	}
	tx, err := m.conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return fail(store.AttachmentMaintenanceSnapshotOpen, err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SET LOCAL TIME ZONE 'UTC'"); err != nil {
		return fail(store.AttachmentMaintenanceSnapshotTimezone, err)
	}
	identity := store.AttachmentMaintenanceIdentity{Host: m.config.Host, Port: strconv.Itoa(int(m.config.Port)), Relations: map[string]string{}}
	if err := tx.QueryRow(ctx, `SELECT current_database(), current_schema(), (SELECT oid::text FROM pg_database WHERE datname=current_database())`).Scan(&identity.Database, &identity.Schema, &identity.DatabaseOID); err != nil {
		return fail(store.AttachmentMaintenanceIdentityRead, err)
	}
	for _, name := range []string{"projects", "tasks", "task_attachments"} {
		var schema, oid string
		if err := tx.QueryRow(ctx, `SELECT n.nspname, c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)`, name).Scan(&schema, &oid); err != nil {
			return fail(store.AttachmentMaintenanceRelationsRead, err)
		}
		identity.Relations[name] = schema + "/" + oid
	}
	if err := visitor.Identity(identity); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id::text, to_jsonb(p)::text FROM projects p ORDER BY id`)
	if err != nil {
		return fail(store.AttachmentMaintenanceProjectsQuery, err)
	}
	for rows.Next() {
		var project store.AttachmentMaintenanceProject
		if err := rows.Scan(&project.ID, &project.Data); err != nil {
			rows.Close()
			return fail(store.AttachmentMaintenanceProjectsDecode, err)
		}
		if err := visitor.Project(project); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fail(store.AttachmentMaintenanceProjectsRead, err)
	}
	rows, err = tx.Query(ctx, `SELECT id::text, project_id::text, to_jsonb(t)::text FROM tasks t ORDER BY id`)
	if err != nil {
		return fail(store.AttachmentMaintenanceTasksQuery, err)
	}
	for rows.Next() {
		var owner store.AttachmentMaintenanceOwner
		if err := rows.Scan(&owner.TaskID, &owner.ProjectID, &owner.Data); err != nil {
			rows.Close()
			return fail(store.AttachmentMaintenanceTasksDecode, err)
		}
		if err := visitor.Owner(owner); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fail(store.AttachmentMaintenanceTasksRead, err)
	}
	rows, err = tx.Query(ctx, `SELECT project_id::text, task_id::text, path, size_bytes, to_jsonb(a)::text FROM task_attachments a ORDER BY task_id, path COLLATE "C"`)
	if err != nil {
		return fail(store.AttachmentMaintenanceMetadataQuery, err)
	}
	for rows.Next() {
		var metadata store.AttachmentMaintenanceMetadata
		if err := rows.Scan(&metadata.ProjectID, &metadata.TaskID, &metadata.Path, &metadata.SizeBytes, &metadata.Data); err != nil {
			rows.Close()
			return fail(store.AttachmentMaintenanceMetadataDecode, err)
		}
		if err := visitor.Metadata(metadata); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fail(store.AttachmentMaintenanceMetadataRead, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fail(store.AttachmentMaintenanceSnapshotCommit, err)
	}
	return nil
}
