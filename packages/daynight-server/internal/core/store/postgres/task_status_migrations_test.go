package postgres

import (
	"context"
	"errors"
	"math"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskProposedMigrationPreservesExistingResourcesAndDefault(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:6]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := projectBeforeSettings(t, database, 1)
	created := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	updated := created.Add(time.Hour)
	before := make([]model.Task, 0, 3)
	for index, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		id := queryID(index + 10)
		mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
			VALUES ($1, $2, 'Existing task', 'Existing description', $3, $4, $5, $6)`, id, project.ID, status, index+17, created, updated)
		before = append(before, snapshotTaskBeforeTiming(t, database, project.ID, id))
	}
	_, err := pool.Exec(ctx, `INSERT INTO tasks (id, project_id, title, status) VALUES ($1, $2, 'Proposed', 'proposed')`, queryID(20), project.ID)
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23514" {
		t.Fatalf("old schema did not reject proposed: %v", err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:7]); err != nil {
		t.Fatal(err)
	}
	for _, original := range before {
		if after := snapshotTaskBeforeTiming(t, database, project.ID, original.ID); !reflect.DeepEqual(after, original) {
			t.Fatalf("migration changed existing resource: %#v versus %#v", after, original)
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title, status) VALUES ($1, $2, 'Proposed', 'proposed')`, queryID(20), project.ID)
	mustQueryExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES ($1, $2, $3)`, project.ID, queryID(20), before[0].ID)
	proposed := snapshotTaskBeforeTiming(t, database, project.ID, queryID(20))
	if proposed.Status != model.TaskStatus("proposed") || proposed.Ready || !slices.Equal(proposed.BlockedBy, []string{before[0].ID}) {
		t.Fatalf("migrated proposed resource: %#v", proposed)
	}
	mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title) VALUES ($1, $2, 'Default')`, queryID(21), project.ID)
	if task := snapshotTaskBeforeTiming(t, database, project.ID, queryID(21)); task.Status != model.TaskTodo || !task.Ready {
		t.Fatalf("migration changed database creation default: %#v", task)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=7").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:7]); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=7").Scan(&after); err != nil || !after.Equal(applied) || !reflect.DeepEqual(snapshotTaskBeforeTiming(t, database, project.ID, proposed.ID), proposed) {
		t.Fatalf("repeated migration changed ledger/resource: %v, %v", after, err)
	}
}

func TestTaskProposedDefaultMigrationPreservesExistingResources(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:7]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := projectBeforeSettings(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	var before []model.Task
	for index, status := range []model.TaskStatus{model.TaskStatus("proposed"), model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		id := queryID(index + 10)
		mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
			VALUES ($1, $2, 'Existing task', 'Existing description', $3, $4, $5, $6)`, id, project.ID, status, index+17, stamp, stamp.Add(time.Hour))
		before = append(before, snapshotTaskBeforeTiming(t, database, project.ID, id))
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	for _, original := range before {
		if after := snapshotHistoricalTask(t, database, project.ID, original.ID); !reflect.DeepEqual(after, original) {
			t.Fatalf("default migration changed existing resource: %#v versus %#v", after, original)
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title) VALUES ($1, $2, 'Default')`, queryID(21), project.ID)
	created := snapshotHistoricalTask(t, database, project.ID, queryID(21))
	if created.Status != model.TaskStatus("proposed") || created.Ready || created.Version != 1 || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("database default did not create proposed task: %#v", created)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=8").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=8").Scan(&after); err != nil || !after.Equal(applied) || !reflect.DeepEqual(snapshotHistoricalTask(t, database, project.ID, created.ID), created) {
		t.Fatalf("repeated default migration changed ledger/resource: %v, %v", after, err)
	}
}

// Historical schemas predate typed resources and their ready predicate.
const historicalTaskReady = `(t.status = 'todo' AND NOT EXISTS (
 SELECT 1 FROM task_dependencies d WHERE d.project_id = t.project_id AND d.task_id = t.id
 AND ` + pg.TaskDependencyUnsatisfied + `))`

// Pre-timing rows have unknown execution intervals and gain the explicit legacy permission during migration.
func snapshotTaskBeforeTiming(t *testing.T, database *Store, projectID, id string) model.Task {
	t.Helper()
	task, err := scanHistoricalTask(database.Pool.QueryRow(context.Background(), `SELECT
		t.id::text, t.project_id::text, t.title, t.description, t.status, t.version,
		t.created_at, t.updated_at, NULL::timestamptz, NULL::timestamptz, true, NULL::text, t.properties, `+
		pg.TaskDependsOn+`, ARRAY[]::text[], `+pg.TaskBlockedBy+`, `+historicalTaskReady+`
		FROM tasks t WHERE t.project_id = $1 AND t.id = $2`, projectID, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

// Historical migration assertions decode the schema they own without accepting legacy states at runtime.
func scanHistoricalTask(row pgx.Row) (model.Task, error) {
	var task model.Task
	var properties string
	err := row.Scan(&task.ID, &task.ProjectID, &task.Title, &task.Description, &task.Status,
		&task.Version, &task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.AllowAgents, &task.RequiredPlatform, &properties, &task.DependsOn, &task.ExternalDependsOn, &task.BlockedBy, &task.Ready)
	if err != nil {
		return model.Task{}, err
	}
	task.Properties, err = decodeHistoricalPropertiesFixture([]byte(properties))
	task.CreatedAt, task.UpdatedAt = task.CreatedAt.UTC(), task.UpdatedAt.UTC()
	task.StartedAt, task.CompletedAt = pg.UTCTime(task.StartedAt), pg.UTCTime(task.CompletedAt)
	return task, err
}

const historicalTaskProjection = `t.id::text, t.project_id::text, t.title, t.description,
 t.status, t.version, t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents, NULL::text, t.properties, ` + pg.TaskDependsOn + `, ` + pg.TaskExternalDependsOn + `, ` + pg.TaskBlockedBy + `, ` + historicalTaskReady

func snapshotHistoricalTask(t *testing.T, database *Store, projectID, id string) model.Task {
	t.Helper()
	task, err := scanHistoricalTask(database.Pool.QueryRow(context.Background(), `SELECT `+historicalTaskProjection+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

const historicalPlatformTaskProjection = `t.id::text, t.project_id::text, t.title, t.description,
 t.status, t.version, t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents, t.required_platform, t.properties, ` + pg.TaskDependsOn + `, ` + pg.TaskExternalDependsOn + `, ` + pg.TaskBlockedBy + `, ` + historicalTaskReady

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
	ready := statusMigrationTask(t, database, project.ID, queryID(10))
	blocked := statusMigrationTask(t, database, project.ID, queryID(11))
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
	created := statusMigrationTask(t, database, project.ID, queryID(30))
	if created.Status != model.TaskTodo || !created.Ready || created.AllowAgents || created.RequiredPlatform != nil || created.Version != 1 || created.StartedAt != nil || created.CompletedAt != nil || !created.CreatedAt.Equal(created.UpdatedAt) {
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

func statusMigrationTask(t *testing.T, database *Store, projectID, id string) model.Task {
	t.Helper()
	task, err := scanHistoricalTask(database.Pool.QueryRow(context.Background(), `SELECT `+historicalPlatformTaskProjection+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestTaskSoftDeleteMigrationPreservesHistory(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:16]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,properties)
		VALUES($1,$2,'Historic','Opaque description','done',9007199254740993,'{"pullRequests":[],"worker":null}')`, queryID(11), project.ID)
	var before, after string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := migrate(ctx, pool, schemaMigrations[:17]); err != nil {
			t.Fatal(err)
		}
		var marker bool
		if err := pool.QueryRow(ctx, `SELECT (to_jsonb(t)-'deleted_at')::text,deleted_at IS NULL FROM tasks t`).Scan(&after, &marker); err != nil || before != after || !marker {
			t.Fatalf("migration changed existing task facts: %s %s %v", before, after, err)
		}
	}
	if task := snapshotHistoricalTask(t, database, project.ID, queryID(11)); task.Version != 9007199254740993 || task.Status != model.TaskDone {
		t.Fatal("existing task no longer decodes")
	}
}

func cancellationMigrationRows(t *testing.T, database *Store) []string {
	t.Helper()
	rows, err := database.Pool.Query(t.Context(), `SELECT (to_jsonb(t)-'cancelled_at'-'type'-'parent_id')::text FROM tasks t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var row string
		if err := rows.Scan(&row); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func cancellationMigrationFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := statusMigrationRelatedFacts(t, database)
	for name, query := range map[string]string{
		"properties": `SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name)::text FROM task_properties p`,
		"ledger":     `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<46`,
	} {
		var value string
		if err := database.Pool.QueryRow(t.Context(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		facts[name] = value
	}
	return facts
}

func TestCancellationMigrationPreservesHistoricalTasksAndRejectsInconsistentTime(t *testing.T) {
	pool := emptyPool(t)
	previous := schemaMigrations[:45]
	if err := migrate(t.Context(), pool, previous); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	for index, status := range []string{"todo", "in_progress", "done"} {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,allow_agents,required_platform,assigned_to,started_at,completed_at)
			VALUES($1,$2,'[Cancelled] retained history','## Preserved',$3,9007199254740993,true,'linux',$4,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`, queryID(index+10), project.ID, status, queryID(5))
	}
	mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[{"url":"opaque","title":"Original"}]')`, queryID(10))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'nested/proof.md','text/markdown',13)`, project.ID, queryID(10))
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false),($1,$2,$4,true)`, project.ID, queryID(10), queryID(11), queryID(12))
	before, related := cancellationMigrationRows(t, database), cancellationMigrationFacts(t, database)
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cancellationMigrationRows(t, database), before) || !reflect.DeepEqual(cancellationMigrationFacts(t, database), related) {
		t.Fatal("cancellation migration changed existing task data or related resources")
	}
	var nonnull int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM tasks WHERE cancelled_at IS NOT NULL`).Scan(&nonnull); err != nil || nonnull != 0 {
		t.Fatalf("historical task received cancellation time: %d %v", nonnull, err)
	}
	for _, mutation := range []string{
		`UPDATE tasks SET status='cancelled' WHERE id=$1`,
		`UPDATE tasks SET cancelled_at=statement_timestamp() WHERE id=$1`,
		`UPDATE tasks SET status='cancel',cancelled_at=statement_timestamp() WHERE id=$1`,
	} {
		_, err := pool.Exec(t.Context(), mutation, queryID(10))
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != "23514" {
			t.Fatalf("inconsistent cancellation state was not rejected: %v", err)
		}
	}
	mustQueryExec(t, database, `UPDATE tasks SET status='cancelled',cancelled_at=statement_timestamp() WHERE id=$1`, queryID(10))
	var original string
	if err := pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, queryID(10)).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var repeated string
	if err := pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, queryID(10)).Scan(&repeated); err != nil || repeated != original {
		t.Fatalf("repeat changed cancellation data: %v", err)
	}
}

func TestCancellationMigrationFailureRollsBackColumnConstraintAndLedger(t *testing.T) {
	pool := emptyPool(t)
	previous := schemaMigrations[:45]
	if err := migrate(t.Context(), pool, previous); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Preserved')`, queryID(10), project.ID)
	before := cancellationMigrationRows(t, database)
	mustQueryExec(t, database, `CREATE FUNCTION reject_cancellation_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.version=46 THEN RAISE EXCEPTION USING ERRCODE='P1046',MESSAGE='ledger rejection'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_cancellation_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_cancellation_ledger()`)
	err := migrate(t.Context(), pool, schemaMigrations)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P1046" {
		t.Fatalf("migration lost ledger failure: %v", err)
	}
	var columns, ledger int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='cancelled_at'`).Scan(&columns); err != nil || columns != 0 {
		t.Fatalf("failed migration retained new column: %d %v", columns, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM schema_migrations WHERE version=46`).Scan(&ledger); err != nil || ledger != 0 || !reflect.DeepEqual(cancellationMigrationRows(t, database), before) {
		t.Fatalf("failed migration partially changed data/ledger: %d %v", ledger, err)
	}
	mustQueryExec(t, database, `DROP TRIGGER reject_cancellation_ledger ON schema_migrations; DROP FUNCTION reject_cancellation_ledger()`)
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatalf("migration failed after repairing cause: %v", err)
	}
}
