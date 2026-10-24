package store

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5/pgconn"
)

type statusMigrationRow struct {
	ID        string
	Status    string
	Version   int64
	UpdatedAt time.Time
	Materials string
}

func statusMigrationRows(t *testing.T, database *Store) []statusMigrationRow {
	t.Helper()
	rows, err := database.Pool.Query(context.Background(), `SELECT id::text,status,version,updated_at,
		(to_jsonb(t)-'status'-'version'-'updated_at')::text FROM tasks t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []statusMigrationRow
	for rows.Next() {
		var row statusMigrationRow
		if err := rows.Scan(&row.ID, &row.Status, &row.Version, &row.UpdatedAt, &row.Materials); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func statusMigrationRelatedFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := make(map[string]string)
	for name, query := range map[string]string{
		"projects":     `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text FROM projects t`,
		"attachments":  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id,path),'[]'::jsonb)::text FROM task_attachments t`,
		"dependencies": `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id,task_id,depends_on_task_id),'[]'::jsonb)::text FROM task_dependencies t`,
		"ledger":       `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=13`,
	} {
		var value string
		if err := database.Pool.QueryRow(context.Background(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		facts[name] = value
	}
	return facts
}

func TestTaskStatusMigrationConvertsOnlyLegacyStatesAndPreservesMaterials(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	statuses := []string{"proposed", "proposed", "proposed", "proposed", "todo", "in_progress", "done"}
	for index, status := range statuses {
		var started, completed *time.Time
		if index < 2 || index >= 4 {
			start, end := stamp.Add(time.Minute), stamp.Add(2*time.Minute)
			started, completed = &start, &end
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,allow_agents,required_platform,properties)
			VALUES($1,$2,'Preserved title','## Complete Markdown\nPreserved body',$3,$4,$5,$6,$7,$8,$9,$10,
			'{"pullRequests":[{"url":"https://example.com/pr/1","title":"Preserved PR"}]}')`,
			queryID(index+10), project.ID, status, int64(9007199254740993)+int64(index), stamp, stamp.Add(time.Hour), started, completed, index%2 == 1, []any{nil, "windows", "linux", "macos", nil, "windows", "linux"}[index])
		mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes,created_at,updated_at)
			VALUES($1,$2,'plan.md','text/markdown',123,$3,$4)`, project.ID, queryID(index+10), stamp, stamp.Add(time.Hour))
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external)
		VALUES($1,$2,$3,false),($1,$4,$5,true),($1,$6,$3,true)`, project.ID, queryID(10), queryID(16), queryID(11), queryID(14), queryID(12))
	before, facts := statusMigrationRows(t, database), statusMigrationRelatedFacts(t, database)
	var lower, upper time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&lower); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:14]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&upper); err != nil {
		t.Fatal(err)
	}
	after := statusMigrationRows(t, database)
	if len(after) != len(before) || !reflect.DeepEqual(statusMigrationRelatedFacts(t, database), facts) {
		t.Fatal("status migration changed task inventory or related resources")
	}
	var convertedAt time.Time
	for index, original := range before {
		if original.Status != "proposed" {
			if !reflect.DeepEqual(after[index], original) {
				t.Fatalf("migration changed a nonlegacy task: before %#v after %#v", original, after[index])
			}
			continue
		}
		if after[index].UpdatedAt.Before(lower) || after[index].UpdatedAt.After(upper) {
			t.Fatalf("conversion did not use the database migration statement time: %#v", after[index])
		}
		if convertedAt.IsZero() {
			convertedAt = after[index].UpdatedAt
		} else if !after[index].UpdatedAt.Equal(convertedAt) {
			t.Fatal("legacy rows did not share the conversion statement time")
		}
		original.Status, original.Version, original.UpdatedAt = "todo", original.Version+1, after[index].UpdatedAt
		if !reflect.DeepEqual(after[index], original) {
			t.Fatalf("migration changed legacy materials or lost the exact version: expected %#v actual %#v", original, after[index])
		}
	}
	ready := snapshotTask(t, database, project.ID, queryID(10))
	blocked := snapshotTask(t, database, project.ID, queryID(11))
	if !ready.Ready || blocked.Ready || !reflect.DeepEqual(blocked.BlockedBy, []string{queryID(14)}) || !reflect.DeepEqual(blocked.ExternalDependsOn, []string{queryID(14)}) {
		t.Fatalf("converted readiness lost ordinary or external prerequisites: ready %#v blocked %#v", ready, blocked)
	}
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=14`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:14]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=14`).Scan(&repeated); err != nil || !applied.Equal(repeated) || !reflect.DeepEqual(statusMigrationRows(t, database), after) || !reflect.DeepEqual(statusMigrationRelatedFacts(t, database), facts) {
		t.Fatalf("repeated migration changed ledger or resources: %v", err)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Default todo')`, queryID(30), project.ID)
	created := snapshotTask(t, database, project.ID, queryID(30))
	if created.Status != core.TaskTodo || !created.Ready || created.AllowAgents || created.RequiredPlatform != nil || created.Version != 1 || created.StartedAt != nil || created.CompletedAt != nil || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("current database defaults are not an unstarted todo: %#v", created)
	}
	for _, query := range []string{
		`INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Rejected legacy','proposed')`,
		`UPDATE tasks SET status='proposed' WHERE id=$1 AND project_id=$2`,
	} {
		_, err := pool.Exec(ctx, query, queryID(30), project.ID)
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != "23514" {
			t.Fatalf("current schema accepted legacy status: %v", err)
		}
	}
}

func TestTaskStatusMigrationRollsBackDefaultRowsConstraintAndLedger(t *testing.T) {
	for _, failure := range []string{"version overflow", "ledger insertion"} {
		t.Run(failure, func(t *testing.T) {
			ctx := context.Background()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
				t.Fatal(err)
			}
			database := &Store{Pool: pool}
			project := queryProject(t, database, 1)
			version := int64(17)
			code := "P1014"
			if failure == "version overflow" {
				version, code = math.MaxInt64, "22003"
			} else {
				mustQueryExec(t, database, `CREATE FUNCTION reject_status_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN IF NEW.version=14 THEN RAISE EXCEPTION USING ERRCODE='P1014', MESSAGE='status ledger rejection'; END IF; RETURN NEW; END $$;
					CREATE TRIGGER reject_status_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_status_ledger()`)
			}
			mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,version) VALUES($1,$2,'Legacy default',$3)`, queryID(10), project.ID, version)
			before, facts := statusMigrationRows(t, database), statusMigrationRelatedFacts(t, database)
			err := migrate(ctx, pool, schemaMigrations[:14])
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != code {
				t.Fatalf("migration did not preserve its failure: %v", err)
			}
			if !reflect.DeepEqual(statusMigrationRows(t, database), before) || !reflect.DeepEqual(statusMigrationRelatedFacts(t, database), facts) {
				t.Fatal("failed migration partially changed rows or related resources")
			}
			var count int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=14`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("failed migration retained its ledger: %d %v", count, err)
			}
			mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Old default remains')`, queryID(11), project.ID)
			var status string
			if err := pool.QueryRow(ctx, `SELECT status FROM tasks WHERE id=$1`, queryID(11)).Scan(&status); err != nil || status != "proposed" {
				t.Fatalf("failed migration changed the default or constraint: %q %v", status, err)
			}
			if failure == "version overflow" {
				mustQueryExec(t, database, `UPDATE tasks SET version=17 WHERE id=$1`, queryID(10))
			} else {
				mustQueryExec(t, database, `DROP TRIGGER reject_status_ledger ON schema_migrations; DROP FUNCTION reject_status_ledger()`)
			}
			if err := migrate(ctx, pool, schemaMigrations[:14]); err != nil {
				t.Fatalf("migration could not succeed after the cause was repaired: %v", err)
			}
			for _, row := range statusMigrationRows(t, database) {
				if row.Status != "todo" || row.Version != map[string]int64{queryID(10): 18, queryID(11): 2}[row.ID] {
					t.Fatalf("repaired migration did not convert once: %#v", row)
				}
			}
		})
	}
}
