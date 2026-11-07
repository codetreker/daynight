package maintenance

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/jackc/pgx/v5"
)

func inputField(value *string, bytes, characters int64) store.InputLimitsField {
	return store.InputLimitsField{Present: value != nil, Bytes: bytes, Characters: characters, Value: value}
}
func stringField(value *string) store.InputLimitsField {
	if value == nil {
		return store.InputLimitsField{}
	}
	return inputField(value, int64(len(*value)), int64(len([]rune(*value))))
}

// Each task is located with a fixed-width UUID and length-only metadata. Values
// and associated rows are only fetched after the complete raw candidate fits.
func scanInputTasks(ctx context.Context, tx pgx.Tx, visitor store.InputLimitsVisitor) error {
	var last *string
	for {
		var id, project string
		var titleBytes, titleChars, descriptionBytes, descriptionChars, propertyBytes, dependencies, otherBytes, dependencyBytes int64
		err := tx.QueryRow(ctx, `SELECT t.id::text,t.project_id::text,octet_length(t.title),char_length(t.title),octet_length(t.description),char_length(t.description),
		coalesce((SELECT sum(octet_length(p.name)::bigint+octet_length(p.value)::bigint) FROM task_properties p WHERE p.task_id=t.id),0),
		(SELECT count(*) FROM task_dependencies d WHERE d.project_id=t.project_id AND d.task_id=t.id),
		octet_length(concat(t.id::text,t.project_id::text,t.status,t.version::text,t.created_at::text,t.updated_at::text,t.allow_agents::text,t.started_at::text,t.completed_at::text,t.cancelled_at::text,t.required_platform,t.assigned_to::text,t.deleted_at::text,
		(status='todo' AND NOT EXISTS (SELECT 1 FROM task_dependencies d WHERE d.project_id=t.project_id AND d.task_id=t.id AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id=d.project_id AND p.id=d.depends_on_task_id AND p.status IN ('done','cancelled'))))::text)),
		(SELECT 2*count(*)+36*(count(*)+count(*) FILTER (WHERE d.external)+count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id=d.project_id AND p.id=d.depends_on_task_id AND p.status IN ('done','cancelled')))) FROM task_dependencies d WHERE d.project_id=t.project_id AND d.task_id=t.id)
		FROM tasks t WHERE ($1::uuid IS NULL OR t.id>$1::uuid) ORDER BY t.id LIMIT 1`, last).Scan(&id, &project, &titleBytes, &titleChars, &descriptionBytes, &descriptionChars, &propertyBytes, &dependencies, &otherBytes, &dependencyBytes)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return fmt.Errorf("input limits task metadata: %w", err)
		}
		last = &id
		record := store.InputLimitsRecord{Kind: "task", IDs: map[string]string{"id": id, "projectId": project}, Fields: map[string]store.InputLimitsField{
			"title": {Present: true, Bytes: titleBytes, Characters: titleChars}, "description": {Present: true, Bytes: descriptionBytes, Characters: descriptionChars},
		}, Numbers: map[string]int64{"dependencies": dependencies, "propertyBytes": propertyBytes, "otherBytes": otherBytes, "dependencyBytes": dependencyBytes}, CandidateComplete: false}
		// Include every projected scalar, property name/value and each selected
		// fixed-width UUID in the three dependency arrays before fetching data.
		// Each edge query also reads two PostgreSQL binary boolean values.
		if titleBytes+descriptionBytes+propertyBytes+otherBytes+dependencyBytes <= inputCandidateBytes {
			var title, description, status, created, updated, version, allow, ready string
			var started, completed, cancelled, platform, assigned, deleted *string
			err = tx.QueryRow(ctx, `SELECT title,description,status,created_at::text,updated_at::text,version::text,allow_agents::text,
			started_at::text,completed_at::text,cancelled_at::text,required_platform,assigned_to::text,deleted_at::text,
			(status='todo' AND NOT EXISTS (SELECT 1 FROM task_dependencies d WHERE d.project_id=t.project_id AND d.task_id=t.id AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id=d.project_id AND p.id=d.depends_on_task_id AND p.status IN ('done','cancelled'))))::text
			FROM tasks t WHERE id=$1::uuid`, id).Scan(&title, &description, &status, &created, &updated, &version, &allow, &started, &completed, &cancelled, &platform, &assigned, &deleted, &ready)
			if err != nil {
				return fmt.Errorf("input limits task candidate: %w", err)
			}
			for key, value := range map[string]*string{"title": &title, "description": &description, "status": &status, "createdAt": &created, "updatedAt": &updated, "version": &version, "allowAgents": &allow, "ready": &ready, "startedAt": started, "completedAt": completed, "cancelledAt": cancelled, "requiredPlatform": platform, "assignedTo": assigned, "deletedAt": deleted} {
				record.Fields[key] = stringField(value)
			}
			record.Properties = map[string]string{}
			rows, err := tx.Query(ctx, `SELECT name,value FROM task_properties WHERE task_id=$1::uuid ORDER BY name COLLATE "C"`, id)
			if err != nil {
				return fmt.Errorf("input limits task properties: %w", err)
			}
			for rows.Next() {
				var name, value string
				if err = rows.Scan(&name, &value); err != nil {
					rows.Close()
					return fmt.Errorf("input limits task property: %w", err)
				}
				record.Properties[name] = value
			}
			if err = rows.Err(); err != nil {
				rows.Close()
				return fmt.Errorf("input limits task properties: %w", err)
			}
			rows.Close()
			record.Dependencies = []string{}
			record.ExternalDependencies = []string{}
			record.BlockedBy = []string{}
			rows, err = tx.Query(ctx, `SELECT d.depends_on_task_id::text,d.external,NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id=d.project_id AND p.id=d.depends_on_task_id AND p.status IN ('done','cancelled')) FROM task_dependencies d WHERE d.project_id=$1::uuid AND d.task_id=$2::uuid ORDER BY d.depends_on_task_id`, project, id)
			if err != nil {
				return fmt.Errorf("input limits task dependencies: %w", err)
			}
			for rows.Next() {
				var dep string
				var external, blocked bool
				if err = rows.Scan(&dep, &external, &blocked); err != nil {
					rows.Close()
					return fmt.Errorf("input limits task dependency: %w", err)
				}
				record.Dependencies = append(record.Dependencies, dep)
				if external {
					record.ExternalDependencies = append(record.ExternalDependencies, dep)
				}
				if blocked {
					record.BlockedBy = append(record.BlockedBy, dep)
				}
			}
			if err = rows.Err(); err != nil {
				rows.Close()
				return fmt.Errorf("input limits task dependencies: %w", err)
			}
			rows.Close()
			record.CandidateComplete = true
		}
		if err = visitor.Record(record); err != nil {
			return err
		}
	}
}

func scanActiveOwners(ctx context.Context, tx pgx.Tx, visitor store.InputLimitsVisitor, observed time.Time) error {
	var after *string
	for {
		var id string
		var count int64
		err := tx.QueryRow(ctx, `SELECT user_id::text,count(*) FROM workers
		WHERE last_seen_at <= $1 AND last_seen_at > $2 AND ($3::uuid IS NULL OR user_id>$3::uuid)
		GROUP BY user_id ORDER BY user_id LIMIT 1`, observed, observed.Add(-worker.ActiveWindow), after).Scan(&id, &count)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return fmt.Errorf("input limits active owner: %w", err)
		}
		after = &id
		if err = visitor.Record(store.InputLimitsRecord{Kind: "activeOwner", IDs: map[string]string{"userId": id}, Numbers: map[string]int64{"count": count}, CandidateComplete: true}); err != nil {
			return err
		}
	}
}
