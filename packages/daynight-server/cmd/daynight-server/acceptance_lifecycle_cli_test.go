package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

type acceptanceLifecycleEvidence struct {
	Scope     string                           `json:"scope"`
	Platform  string                           `json:"platform"`
	Migration *acceptanceLifecycleMigration    `json:"migration,omitempty"`
	Actions   []acceptanceLifecycleAction      `json:"actions,omitempty"`
	Refusals  []acceptanceLifecycleRefusal     `json:"refusals,omitempty"`
	Race      *acceptanceLifecycleRaceEvidence `json:"race,omitempty"`
}

type acceptanceMigrationEntry struct {
	Version   int64     `json:"version"`
	Checksum  string    `json:"checksum"`
	AppliedAt time.Time `json:"appliedAt"`
}

type acceptanceHistoricalRow struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

type acceptanceLifecycleMigration struct {
	BeforeLedger       []acceptanceMigrationEntry `json:"beforeLedger"`
	AfterLedger        []acceptanceMigrationEntry `json:"afterLedger"`
	BeforeRows         []acceptanceHistoricalRow  `json:"beforeRows"`
	StatusBeforeLedger []acceptanceMigrationEntry `json:"statusBeforeLedger"`
	StatusBeforeRows   []acceptanceHistoricalRow  `json:"statusBeforeRows"`
	AfterRows          []acceptanceHistoricalRow  `json:"afterRows"`
	RestartRows        []acceptanceHistoricalRow  `json:"restartRows"`
	BeforeEdges        string                     `json:"beforeEdges"`
	AfterEdges         string                     `json:"afterEdges"`
	RestartEdges       string                     `json:"restartEdges"`
	BeforeAttachments  string                     `json:"beforeAttachments"`
	AfterAttachments   string                     `json:"afterAttachments"`
	RestartAttachments string                     `json:"restartAttachments"`
	TaskCacheEpoch     string                     `json:"taskCacheEpoch"`
	RestartCacheEpoch  string                     `json:"restartCacheEpoch"`
}

type acceptanceLifecycleAction struct {
	Action string   `json:"action"`
	Before api.Task `json:"before"`
	After  api.Task `json:"after"`
	Output string   `json:"output"`
}

type acceptanceLifecycleRefusal struct {
	Code   string   `json:"code"`
	Before api.Task `json:"before"`
	After  api.Task `json:"after"`
	Stderr string   `json:"stderr"`
}

type acceptanceLifecycleRaceEvidence struct {
	Kind     string                          `json:"kind"`
	Before   api.Task                        `json:"before"`
	After    api.Task                        `json:"after"`
	Requests []acceptanceCLIRequest          `json:"requests"`
	Results  []acceptanceLifecycleRaceResult `json:"results"`
}

type acceptanceLifecycleRaceResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func newLifecycleEvidence(t *testing.T, scenario *acceptanceScenario) *acceptanceLifecycleEvidence {
	t.Helper()
	evidence := &acceptanceLifecycleEvidence{Scope: "real PostgreSQL, built process and packed installed CLI", Platform: runtime.GOOS + "/" + runtime.GOARCH}
	if err := binaryAcceptance.update(func() { scenario.Lifecycle = evidence }); err != nil {
		t.Fatal("cannot persist lifecycle scenario identity")
	}
	return evidence
}

func acceptanceCLISetStatus(t *testing.T, cli *acceptanceCLI, process *acceptanceProcess, evidence *acceptanceLifecycleEvidence, before api.Task, status string) api.Task {
	t.Helper()
	count := len(acceptanceCLIMutations(process))
	output := cli.run(t, cli.caller, "task", "set-status", before.ID, status, "--project", before.ProjectID, "--if-version", strconv.FormatInt(before.Version, 10))
	requests := acceptanceCLIWaitMutations(t, process, count+1)
	if len(requests) != count+1 || requests[count].Status != 200 {
		t.Fatal("installed status assignment did not make exactly one successful mutation")
	}
	after := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", before.ID, "--project", before.ProjectID, "--json"))
	acceptanceTaskTimingTransition(t, before, after, status)
	preserved := after
	preserved.StartedAt, preserved.CompletedAt = before.StartedAt, before.CompletedAt
	preserved.Status, preserved.Ready, preserved.Version, preserved.UpdatedAt = before.Status, before.Ready, before.Version, before.UpdatedAt
	preserved.BlockedBy = before.BlockedBy
	expectedVersion := before.Version
	changed := before.Status != status
	if changed {
		expectedVersion++
	}
	if after.Status != status || after.Version != expectedVersion || changed && !after.UpdatedAt.After(before.UpdatedAt) || !changed && !after.UpdatedAt.Equal(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) ||
		!strings.Contains(output, "Status: "+status+"\n") || !strings.Contains(output, "Version: "+strconv.FormatInt(after.Version, 10)+"\n") ||
		!strings.Contains(output, "Description: "+strings.ReplaceAll(after.Description, "\n", "\\n")+"\n") {
		t.Fatal("installed status assignment changed unrelated fields or returned the wrong version branch")
	}
	if err := binaryAcceptance.update(func() {
		evidence.Actions = append(evidence.Actions, acceptanceLifecycleAction{Action: "set-status " + status, Before: before, After: after, Output: output})
	}); err != nil {
		t.Fatal("cannot persist status assignment response")
	}
	return after
}

func acceptanceCLIRefusal(t *testing.T, cli *acceptanceCLI, process *acceptanceProcess, evidence *acceptanceLifecycleEvidence, before api.Task, code string, arguments ...string) {
	t.Helper()
	result := cli.refuse(t, process, code, "", arguments...)
	after := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", before.ID, "--project", before.ProjectID, "--json"))
	if !reflect.DeepEqual(after, before) {
		t.Fatal("installed lifecycle refusal changed task data, version or timestamps")
	}
	if err := binaryAcceptance.update(func() {
		evidence.Refusals = append(evidence.Refusals, acceptanceLifecycleRefusal{Code: code, Before: before, After: after, Stderr: result.stderr})
	}); err != nil {
		t.Fatal("cannot persist lifecycle refusal outcome")
	}
}

func acceptanceMigrationLedger(t *testing.T, fixture *acceptanceFixture) []acceptanceMigrationEntry {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	rows, err := fixture.admin.Query(ctx, "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version")
	if err != nil {
		t.Fatal("cannot read historical migration ledger")
	}
	defer rows.Close()
	var result []acceptanceMigrationEntry
	for rows.Next() {
		var entry acceptanceMigrationEntry
		if err := rows.Scan(&entry.Version, &entry.Checksum, &entry.AppliedAt); err != nil {
			t.Fatal("cannot decode historical migration ledger")
		}
		entry.AppliedAt = entry.AppliedAt.UTC()
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		t.Fatal("cannot finish historical migration ledger")
	}
	return result
}

func acceptanceHistoricalRows(t *testing.T, fixture *acceptanceFixture, ids []string) []acceptanceHistoricalRow {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	rows, err := fixture.admin.Query(ctx, "SELECT id::text, to_jsonb(t)::text FROM tasks t WHERE id = ANY($1::uuid[]) ORDER BY id", ids)
	if err != nil {
		t.Fatal("cannot read preserved historical rows")
	}
	defer rows.Close()
	var result []acceptanceHistoricalRow
	for rows.Next() {
		var row acceptanceHistoricalRow
		if err := rows.Scan(&row.ID, &row.Data); err != nil {
			t.Fatal("cannot decode preserved historical row")
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil || len(result) != len(ids) {
		t.Fatal("historical row inventory is incomplete")
	}
	return result
}

func acceptancePreStatusSchema(t *testing.T, fixture *acceptanceFixture) {
	t.Helper()
	fixture.exec(t, `CREATE TABLE schema_migrations (version bigint PRIMARY KEY, checksum text NOT NULL CHECK (length(checksum) = 64), applied_at timestamptz NOT NULL DEFAULT statement_timestamp())`)
	for index, name := range []string{"001_projects.sql", "002_tasks.sql", "003_task_properties.sql", "004_task_attachments.sql", "005_identity.sql", "006_project_membership.sql", "007_task_proposed.sql", "008_task_proposed_default.sql", "009_task_timing.sql", "010_project_settings.sql", "011_task_agent_permission.sql", "012_external_dependencies.sql"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "internal", "core", "store", "migrations", name))
		if err != nil {
			t.Fatal("cannot read genuine pre-status migration SQL")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		tx, err := fixture.admin.Begin(ctx)
		if err == nil {
			_, err = tx.Exec(ctx, string(data))
			if err == nil {
				_, err = tx.Exec(ctx, "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", index+1, fmt.Sprintf("%x", sha256.Sum256(data)))
			}
			if err == nil {
				err = tx.Commit(ctx)
			} else {
				_ = tx.Rollback(ctx)
			}
		}
		cancel()
		if err != nil {
			t.Fatal("cannot apply genuine pre-status migration")
		}
	}
}

func acceptanceLifecycleAttachment(t *testing.T, cli *acceptanceCLI, task api.Task) ([]api.Attachment, []byte) {
	t.Helper()
	content := []byte("# Lifecycle acceptance plan\n\nMetadata and exact attachment bytes survive every transition.\n\nReadable plan: 按已确认范围执行，验收后完成。\n")
	source := filepath.Join(cli.root, "lifecycle-plan.md")
	if err := os.WriteFile(source, content, 0o600); err != nil {
		t.Fatal("cannot create owned lifecycle attachment")
	}
	cli.run(t, cli.caller, "task", "attachment", "put", task.ID, source, "--project", task.ProjectID, "--path", "plans/lifecycle.md")
	metadata := acceptanceCLIJSON[[]api.Attachment](t, cli.run(t, cli.caller, "task", "attachment", "list", task.ID, "--project", task.ProjectID, "--json"))
	if len(metadata) != 1 || metadata[0].Path != "plans/lifecycle.md" || metadata[0].SizeBytes != int64(len(content)) {
		t.Fatal("installed lifecycle attachment did not retain its metadata")
	}
	return metadata, content
}

func acceptanceLifecycleAttachmentUnchanged(t *testing.T, cli *acceptanceCLI, task api.Task, metadata []api.Attachment, content []byte) {
	t.Helper()
	actual := acceptanceCLIJSON[[]api.Attachment](t, cli.run(t, cli.caller, "task", "attachment", "list", task.ID, "--project", task.ProjectID, "--json"))
	if !reflect.DeepEqual(actual, metadata) {
		t.Fatal("lifecycle changed attachment metadata")
	}
	bytes := cli.run(t, cli.caller, "task", "attachment", "read", task.ID, metadata[0].Path, "--project", task.ProjectID)
	if bytes != string(content) {
		t.Fatal("lifecycle changed exact attachment bytes")
	}
}

func acceptanceMigrationMaterials(t *testing.T, fixture *acceptanceFixture, projectID string, ids []string) (string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var edges, attachments string
	if err := fixture.admin.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY task_id, depends_on_task_id), '[]'::jsonb)::text FROM task_dependencies d WHERE project_id=$1 AND task_id=ANY($2::uuid[])`, projectID, ids).Scan(&edges); err != nil {
		t.Fatal("cannot snapshot historical dependency classifications")
	}
	if err := fixture.admin.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY task_id, path), '[]'::jsonb)::text FROM task_attachments a WHERE project_id=$1 AND task_id=ANY($2::uuid[])`, projectID, ids).Scan(&attachments); err != nil {
		t.Fatal("cannot snapshot historical attachment metadata")
	}
	return edges, attachments
}

func acceptanceStatusMigrationRows(t *testing.T, before, after []acceptanceHistoricalRow) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatal("status migration changed the historical row inventory")
	}
	for index, old := range before {
		current := after[index]
		var left, right map[string]json.RawMessage
		if old.ID != current.ID || json.Unmarshal([]byte(old.Data), &left) != nil || json.Unmarshal([]byte(current.Data), &right) != nil {
			t.Fatal("cannot compare historical migration rows")
		}
		if _, exists := left["required_platform"]; !exists {
			left["required_platform"] = json.RawMessage("null")
		}
		if string(right["deleted_at"]) != "null" {
			t.Fatal("soft-delete migration did not preserve historical task visibility")
		}
		left["deleted_at"] = json.RawMessage("null")
		if string(right["worker_needs_attention"]) != "false" {
			t.Fatal("signaling migration incorrectly marked historical tasks as requiring attention")
		}
		left["worker_needs_attention"] = json.RawMessage("false")
		var beforeProperties, afterProperties string
		var beforeFields, afterFields map[string]json.RawMessage
		if json.Unmarshal(left["properties"], &beforeProperties) != nil || json.Unmarshal(right["properties"], &afterProperties) != nil ||
			json.Unmarshal([]byte(beforeProperties), &beforeFields) != nil || json.Unmarshal([]byte(afterProperties), &afterFields) != nil || string(afterFields["worker"]) != "null" {
			t.Fatal("worker migration did not declare absent ownership on historical rows")
		}
		delete(afterFields, "worker")
		if !reflect.DeepEqual(beforeFields, afterFields) {
			t.Fatal("worker migration changed historical opaque property values")
		}
		left["properties"] = right["properties"]
		if string(left["status"]) != `"proposed"` {
			if !reflect.DeepEqual(left, right) {
				t.Fatal("status migration changed a non-legacy row")
			}
			continue
		}
		var version, newVersion int64
		var oldUpdated, newUpdated time.Time
		if json.Unmarshal(left["version"], &version) != nil || json.Unmarshal(right["version"], &newVersion) != nil ||
			json.Unmarshal(left["updated_at"], &oldUpdated) != nil || json.Unmarshal(right["updated_at"], &newUpdated) != nil ||
			string(right["status"]) != `"todo"` || newVersion != version+1 || !newUpdated.After(oldUpdated) {
			t.Fatal("legacy conversion did not change only status, exact version and real update time")
		}
		for _, name := range []string{"status", "version", "updated_at"} {
			delete(left, name)
			delete(right, name)
		}
		if !reflect.DeepEqual(left, right) {
			t.Fatal("legacy conversion changed historical task materials, timing or permission")
		}
	}
}

func TestInstalledCLIStatusMigrationAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_v12_status_migration_restart", []string{"TS1", "TS2", "TS3", "TS5"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		cli := newAcceptanceCLI(t, receipt, scenario)
		evidence := newLifecycleEvidence(t, scenario)
		acceptancePreStatusSchema(t, fixture)
		projectID := "00000000-0000-4000-8000-000000000010"
		ids := []string{"00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000013", "00000000-0000-4000-8000-000000000014", "00000000-0000-4000-8000-000000000015"}
		stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
		fixture.exec(t, "INSERT INTO projects (id, name, repo_url) VALUES ($1, 'Preserved v12 project', 'git@git.example:Org/Repo.git')", projectID)
		properties := api.TaskProperties{PullRequests: []api.PullRequestProperty{{URL: "https://github.com/example/migration/pull/1", Title: "Historical reference"}}}
		encoded, err := json.Marshal(api.TaskWritableProperties{PullRequests: properties.PullRequests})
		if err != nil {
			t.Fatal("cannot encode historical task properties")
		}
		for index, status := range []string{"proposed", "proposed", "todo", "in_progress", "done"} {
			var started, completed *time.Time
			if index == 1 || index == 4 {
				start, end := stamp.Add(2*time.Hour), stamp.Add(3*time.Hour)
				started, completed = &start, &end
			}
			version := int64(17 + index)
			if index == 1 {
				version = 9223372036854775807
			}
			fixture.exec(t, `INSERT INTO tasks (id, project_id, title, description, properties, status, version, created_at, updated_at, started_at, completed_at, allow_agents)
				VALUES ($1,$2,$3,'# Historical plan

Preserve the full Markdown and PR reference.',$4,$5,$6,$7,$8,$9,$10,$11)`, ids[index], projectID, "Historical "+status, string(encoded), status, version, stamp, stamp.Add(time.Hour), started, completed, index%2 == 1)
		}
		fixture.exec(t, `INSERT INTO task_dependencies (project_id,task_id,depends_on_task_id,external) VALUES ($1,$2,$6,true),($1,$3,$4,false),($1,$3,$6,true),($1,$5,$6,false)`, projectID, ids[0], ids[1], ids[2], ids[3], ids[4])
		legacyBytes := []byte("# Historical attachment\n\n迁移必须保留完整附件字节。\n")
		legacyPath := filepath.Join(fixture.storageRoot, "task-attachments", ids[1], "plans", "legacy.md")
		if err := os.MkdirAll(filepath.Dir(legacyPath), 0o700); err != nil {
			t.Fatal("cannot create historical attachment namespace")
		}
		if err := os.WriteFile(legacyPath, legacyBytes, 0o600); err != nil {
			t.Fatal("cannot seed historical attachment bytes")
		}
		fixture.exec(t, `INSERT INTO task_attachments (project_id,task_id,path,content_type,size_bytes,created_at,updated_at) VALUES ($1,$2,'plans/legacy.md','text/markdown',$3,$4,$5)`, projectID, ids[1], len(legacyBytes), stamp, stamp.Add(time.Hour))
		beforeFailure := acceptanceHistoricalRows(t, fixture, ids)
		beforeLedger := acceptanceMigrationLedger(t, fixture)
		beforeEdges, beforeAttachments := acceptanceMigrationMaterials(t, fixture, projectID, ids)
		if len(beforeLedger) != 12 {
			t.Fatal("upgrade fixture did not use the genuine v12 migration prefix")
		}
		acceptanceMigrateAttachmentLayout(t, fixture)
		if !reflect.DeepEqual(acceptanceMigrationLedger(t, fixture), beforeLedger) || !reflect.DeepEqual(acceptanceHistoricalRows(t, fixture, ids), beforeFailure) {
			t.Fatal("attachment layout maintenance changed historical SQL resources")
		}
		layoutEdges, layoutAttachments := acceptanceMigrationMaterials(t, fixture, projectID, ids)
		if layoutEdges != beforeEdges || layoutAttachments != beforeAttachments {
			t.Fatal("attachment layout maintenance changed historical dependencies or attachment metadata")
		}
		if _, err := os.Stat(legacyPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("attachment layout maintenance left the genuine old content path")
		}
		migratedPath := filepath.Join(fixture.storageRoot, "task-attachments", projectID, ids[1][:2], ids[1], "plans", "legacy.md")
		migratedBytes, err := os.ReadFile(migratedPath)
		if err != nil || !bytes.Equal(migratedBytes, legacyBytes) {
			t.Fatal("attachment layout maintenance did not preserve historical bytes at the final path")
		}
		failed := fixture.launch(t, nil)
		failed.stopped(t, 1)
		afterPlatform := acceptanceHistoricalRows(t, fixture, ids)
		platformLedger := acceptanceMigrationLedger(t, fixture)
		if len(platformLedger) != 13 || !reflect.DeepEqual(platformLedger[:12], beforeLedger) || platformLedger[12].Version != 13 {
			t.Fatal("failed status migration changed prior ledger or retained its own entry")
		}
		for index, before := range beforeFailure {
			var expected, actual map[string]json.RawMessage
			if before.ID != afterPlatform[index].ID || json.Unmarshal([]byte(before.Data), &expected) != nil || json.Unmarshal([]byte(afterPlatform[index].Data), &actual) != nil {
				t.Fatal("cannot compare the committed platform migration with failed status migration")
			}
			expected["required_platform"] = json.RawMessage("null")
			if !reflect.DeepEqual(actual, expected) {
				t.Fatal("failed status migration changed task data beyond the committed nullable platform column")
			}
		}
		var defaultValue string
		if err := fixture.admin.QueryRow(context.Background(), `SELECT column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='status'`).Scan(&defaultValue); err != nil || defaultValue != "'proposed'::text" {
			t.Fatal("failed status migration did not roll back the SQL default")
		}
		fixture.exec(t, "UPDATE tasks SET status='proposed',version=18 WHERE id=$1", ids[1])
		platforms := []*string{nil, new("windows"), new("linux"), new("macos"), nil}
		for index, platform := range platforms {
			fixture.exec(t, "UPDATE tasks SET required_platform=$1 WHERE id=$2", platform, ids[index])
		}
		beforeStatus := acceptanceHistoricalRows(t, fixture, ids)
		migration := &acceptanceLifecycleMigration{BeforeLedger: beforeLedger, BeforeRows: beforeFailure, StatusBeforeLedger: platformLedger, StatusBeforeRows: beforeStatus, BeforeEdges: beforeEdges, BeforeAttachments: beforeAttachments}
		if err := binaryAcceptance.update(func() { evidence.Migration = migration }); err != nil {
			t.Fatal("cannot persist genuine pre-upgrade snapshots")
		}
		process := fixture.launch(t, nil).started(t)
		cli.configure(t, process)
		afterLedger, afterRows := acceptanceMigrationLedger(t, fixture), acceptanceHistoricalRows(t, fixture, ids)
		afterEdges, afterAttachments := acceptanceMigrationMaterials(t, fixture, projectID, ids)
		var epoch string
		if err := fixture.admin.QueryRow(context.Background(), "SELECT task_cache_epoch::text FROM projects WHERE id=$1", projectID).Scan(&epoch); err != nil {
			t.Fatal("startup did not initialize the historical project's task cache epoch")
		}
		parsedEpoch, err := uuid.Parse(epoch)
		if err != nil || parsedEpoch == uuid.Nil || parsedEpoch.String() != epoch {
			t.Fatal("migrated task cache epoch is not a canonical nonzero UUID")
		}
		if err := binaryAcceptance.update(func() {
			migration.AfterLedger, migration.AfterRows = afterLedger, afterRows
			migration.AfterEdges, migration.AfterAttachments = afterEdges, afterAttachments
			migration.TaskCacheEpoch = epoch
		}); err != nil {
			t.Fatal("cannot persist migrated schema and resource snapshots")
		}
		if len(migration.AfterLedger) != 26 || !reflect.DeepEqual(migration.AfterLedger[:12], migration.BeforeLedger) || !reflect.DeepEqual(migration.AfterLedger[:13], migration.StatusBeforeLedger) || migration.AfterEdges != beforeEdges || migration.AfterAttachments != beforeAttachments {
			t.Fatal("startup did not append the Worker signaling schema while preserving prior ledger, dependencies and attachments")
		}
		for index, entry := range migration.AfterLedger {
			if entry.Version != int64(index+1) {
				t.Fatal("startup migration ledger is not the complete ordered schema prefix")
			}
		}
		acceptanceStatusMigrationRows(t, migration.StatusBeforeRows, migration.AfterRows)
		user := acceptanceDecode[api.User](t, process.request(context.Background(), http.MethodGet, "/api/v1/me", nil, ""), http.StatusOK)
		fixture.exec(t, "INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'admin')", projectID, user.ID)
		old := make([]api.Task, len(ids))
		for index, id := range ids {
			old[index] = acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", id, "--project", projectID, "--json"))
			if old[index].Status != []string{"todo", "todo", "todo", "in_progress", "done"}[index] || old[index].Version != []int64{18, 19, 19, 20, 21}[index] || !reflect.DeepEqual(old[index].Properties, properties) || old[index].AllowAgents != (index%2 == 1) || !reflect.DeepEqual(old[index].RequiredPlatform, platforms[index]) {
				t.Fatal("installed CLI did not expose the preserved and converted historical resources")
			}
		}
		legacyMetadata := acceptanceCLIJSON[[]api.Attachment](t, cli.run(t, cli.caller, "task", "attachment", "list", ids[1], "--project", projectID, "--json"))
		if len(legacyMetadata) != 1 || cli.run(t, cli.caller, "task", "attachment", "read", ids[1], "plans/legacy.md", "--project", projectID) != string(legacyBytes) {
			t.Fatal("migration changed historical attachment metadata or bytes")
		}
		graph := acceptanceCLIGraphResource(t, cli.run(t, cli.caller, "task", "graph", "--project", projectID, "--json"))
		if graph.Summary != (api.TaskGraphSummary{Total: 5, Todo: 3, InProgress: 1, Done: 1, Ready: 2, Blocked: 1}) {
			t.Fatal("installed graph did not project converted task readiness")
		}
		create := func(title string, dependencies ...string) api.Task {
			arguments := []string{"task", "create", "--project", projectID, "--title", title, "--description", "Complete status plan. Attachment: plans/lifecycle.md\nPreserve this full description.", "--pull-request-url", properties.PullRequests[0].URL, "--pull-request-title", properties.PullRequests[0].Title}
			for _, id := range dependencies {
				arguments = append(arguments, "--depends-on", id)
			}
			id := acceptanceCLIResourceID(t, cli.run(t, cli.caller, arguments...))
			task := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", id, "--project", projectID, "--json"))
			if task.Status != "todo" || task.Version != 1 || task.Ready != (len(dependencies) == 0) || task.AllowAgents || task.StartedAt != nil || task.CompletedAt != nil || !reflect.DeepEqual(task.Properties, properties) {
				t.Fatal("installed creation after genuine upgrade did not produce todo work")
			}
			return task
		}
		prerequisite := create("Migrated prerequisite")
		prerequisiteMetadata, prerequisiteContent := acceptanceLifecycleAttachment(t, cli, prerequisite)
		dependent := create("Migrated dependent", prerequisite.ID)
		metadata, content := acceptanceLifecycleAttachment(t, cli, dependent)
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, dependent, "todo")
		acceptanceCLIRefusal(t, cli, process, evidence, dependent, "dependency_unsatisfied", "task", "set-status", dependent.ID, "in_progress", "--project", projectID, "--if-version", "1")
		prerequisite = acceptanceCLISetStatus(t, cli, process, evidence, prerequisite, "done")
		ready := cli.task(t, dependent.ID)
		if !ready.Ready || ready.Version != dependent.Version || !ready.UpdatedAt.Equal(dependent.UpdatedAt) || len(ready.BlockedBy) != 0 {
			t.Fatal("prerequisite completion changed dependent version or failed to make todo work ready")
		}
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, ready, "in_progress")
		acceptanceCLIRefusal(t, cli, process, evidence, dependent, "version_conflict", "task", "set-status", dependent.ID, "in_progress", "--project", projectID, "--if-version", "1")
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, dependent, "in_progress")
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, dependent, "todo")
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, dependent, "done")
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, dependent, "todo")
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, dependent, "in_progress")
		dependent = acceptanceCLISetStatus(t, cli, process, evidence, dependent, "done")
		acceptanceLifecycleAttachmentUnchanged(t, cli, prerequisite, prerequisiteMetadata, prerequisiteContent)
		acceptanceLifecycleAttachmentUnchanged(t, cli, dependent, metadata, content)
		defaultID := "00000000-0000-4000-8000-000000000016"
		fixture.exec(t, `INSERT INTO tasks (id,project_id,title) VALUES ($1,$2,'Post-migration SQL default')`, defaultID, projectID)
		defaultTask := cli.task(t, defaultID)
		if defaultTask.Status != "todo" || defaultTask.Version != 1 || !defaultTask.Ready || defaultTask.AllowAgents {
			t.Fatal("status migration did not change the SQL creation default to todo")
		}
		if _, err := fixture.admin.Exec(context.Background(), "UPDATE tasks SET status='proposed' WHERE id=$1", defaultID); err == nil {
			t.Fatal("three-state database constraint accepted the removed status")
		}
		exact := create("Exact version before restart")
		const exactVersion int64 = 9007199254740993
		fixture.exec(t, "UPDATE tasks SET version=$1 WHERE id=$2", exactVersion, exact.ID)
		exact = cli.task(t, exact.ID)
		exact = acceptanceCLISetStatus(t, cli, process, evidence, exact, "todo")
		exact = acceptanceCLISetStatus(t, cli, process, evidence, exact, "done")
		exact = acceptanceCLISetStatus(t, cli, process, evidence, exact, "done")
		acceptanceCLIRefusal(t, cli, process, evidence, exact, "version_conflict", "task", "set-status", exact.ID, "done", "--project", projectID, "--if-version", strconv.FormatInt(exactVersion, 10))
		process.signal(t)
		process.stopped(t, 0)
		restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
		for _, before := range append(slices.Clone(old), prerequisite, dependent, defaultTask, exact) {
			if after := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", before.ID, "--project", projectID, "--json")); !reflect.DeepEqual(after, before) {
				t.Fatal("migration recheck changed a preserved or newly assigned status across actual restart")
			}
		}
		acceptanceLifecycleAttachmentUnchanged(t, cli, old[1], legacyMetadata, legacyBytes)
		acceptanceLifecycleAttachmentUnchanged(t, cli, prerequisite, prerequisiteMetadata, prerequisiteContent)
		acceptanceLifecycleAttachmentUnchanged(t, cli, dependent, metadata, content)
		restartRows := acceptanceHistoricalRows(t, fixture, ids)
		restartEdges, restartAttachments := acceptanceMigrationMaterials(t, fixture, projectID, ids)
		var restartEpoch string
		if err := fixture.admin.QueryRow(context.Background(), "SELECT task_cache_epoch::text FROM projects WHERE id=$1", projectID).Scan(&restartEpoch); err != nil {
			t.Fatal("cannot read the task cache epoch after actual restart")
		}
		if err := binaryAcceptance.update(func() {
			migration.RestartRows, migration.RestartEdges, migration.RestartAttachments = restartRows, restartEdges, restartAttachments
			migration.RestartCacheEpoch = restartEpoch
		}); err != nil {
			t.Fatal("cannot persist restarted historical resource snapshots")
		}
		if !reflect.DeepEqual(migration.RestartRows, migration.AfterRows) || migration.RestartEdges != migration.AfterEdges || migration.RestartAttachments != migration.AfterAttachments || !reflect.DeepEqual(acceptanceMigrationLedger(t, fixture), migration.AfterLedger) || migration.RestartCacheEpoch != migration.TaskCacheEpoch {
			t.Fatal("restart repeated the status conversion or changed the migration ledger or task cache epoch")
		}
		if err := binaryAcceptance.update(func() {
			scenario.AttachmentFiles = append(scenario.AttachmentFiles, acceptanceAttachmentEvidence{Path: "plans/legacy.md", SizeBytes: len(legacyBytes), SHA256: fmt.Sprintf("%x", sha256.Sum256(legacyBytes))})
		}); err != nil {
			t.Fatal("cannot persist migration and restart evidence")
		}
		legacyCompleted := acceptanceCLISetStatus(t, cli, restarted, evidence, old[3], "done")
		if legacyCompleted.StartedAt != nil || legacyCompleted.CompletedAt == nil {
			t.Fatal("completing migrated running work invented an unknown historical start")
		}
		restarted.signal(t)
		restarted.stopped(t, 0)
		completedRestart := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": restarted.address}).started(t)
		if after := cli.task(t, legacyCompleted.ID); !reflect.DeepEqual(after, legacyCompleted) {
			t.Fatal("unknown-start completion changed across actual process restart")
		}
		completedRestart.signal(t)
		completedRestart.stopped(t, 0)
	})
}

func TestInstalledCLIStatusRacesAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	for _, kind := range []string{"start", "done", "distinct_targets", "dependency_edit_and_start", "same_state"} {
		acceptanceCase(t, "installed_cli_same_version_"+kind, []string{"TS1", "TS3", "TS5"}, func(t *testing.T, scenario *acceptanceScenario) {
			fixture := newAcceptanceFixture(t, scenario)
			cli := newAcceptanceCLI(t, receipt, scenario)
			evidence := newLifecycleEvidence(t, scenario)
			process := fixture.launch(t, nil).started(t)
			cli.configure(t, process)
			projectID := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "project", "create", "Installed status race"))
			prerequisiteID := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "task", "create", "--title", "Unfinished prerequisite"))
			id := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "task", "create", "--title", "Competing task", "--description", "Complete preserved description. Attachment: plans/lifecycle.md\nReview before execution.", "--pull-request-url", "https://github.com/example/race/pull/9", "--pull-request-title", "Preserved PR reference"))
			before := cli.task(t, id)
			metadata, content := acceptanceLifecycleAttachment(t, cli, before)
			version := strconv.FormatInt(before.Version, 10)
			count := len(acceptanceCLIMutations(process))
			barrier := fixture.projectLock(t, projectID)
			leftStatus := "in_progress"
			if kind == "done" {
				leftStatus = "done"
			} else if kind == "same_state" {
				leftStatus = "todo"
			}
			left := cli.start(t, cli.caller, "task", "set-status", id, leftStatus, "--project", projectID, "--if-version", version)
			var right <-chan acceptanceCLIResult
			switch kind {
			case "start", "done", "same_state":
				right = cli.start(t, cli.caller, "task", "set-status", id, leftStatus, "--project", projectID, "--if-version", version)
			case "distinct_targets":
				right = cli.start(t, cli.caller, "task", "set-status", id, "done", "--project", projectID, "--if-version", version)
			case "dependency_edit_and_start":
				right = cli.start(t, cli.caller, "task", "update", id, "--project", projectID, "--if-version", version, "--depends-on", prerequisiteID)
			}
			fixture.waitWriters(t, process, 2)
			acceptanceRelease(t, barrier)
			results := []acceptanceCLIResult{acceptanceCLIReceive(t, left), acceptanceCLIReceive(t, right)}
			requests := acceptanceCLIWaitMutations(t, process, count+2)
			if len(requests) != count+2 {
				t.Fatal("installed status competition retried a mutation")
			}
			requests = requests[count:]
			statuses := []int{requests[0].Status, requests[1].Status}
			slices.Sort(statuses)
			wantStatuses, expectedVersion := []int{200, 409}, before.Version+1
			if kind == "same_state" {
				wantStatuses, expectedVersion = []int{200, 200}, before.Version
			}
			if !slices.Equal(statuses, wantStatuses) || requests[0].RequestID == "" || requests[1].RequestID == "" || requests[0].RequestID == requests[1].RequestID {
				t.Fatal("installed status competition lost its exact outcomes or correlated request IDs")
			}
			won, lost := 0, 0
			captured := make([]acceptanceLifecycleRaceResult, 0, 2)
			for _, result := range results {
				captured = append(captured, acceptanceLifecycleRaceResult{ExitCode: result.status, Stdout: result.stdout, Stderr: result.stderr})
				if result.status == 0 && result.stderr == "" && strings.Contains(result.stdout, "Version: "+strconv.FormatInt(expectedVersion, 10)+"\n") {
					won++
					continue
				}
				if result.status == 1 && result.stdout == "" && strings.Contains(result.stderr, "version_conflict") && strings.Contains(result.stderr, id) {
					matched := false
					for _, request := range requests {
						if request.Status == 409 && strings.Contains(result.stderr, "requestId="+request.RequestID) {
							matched = true
						}
					}
					if matched {
						lost++
						continue
					}
				}
				t.Fatalf("installed status competition returned an unexpected process result: %+v", result)
			}
			if kind == "same_state" && (won != 2 || lost != 0) || kind != "same_state" && (won != 1 || lost != 1) {
				t.Fatal("installed status competition exposed the wrong number of successful and conflicting processes")
			}
			after := cli.task(t, id)
			acceptanceTaskTimingTransition(t, before, after, after.Status)
			preserved := after
			preserved.StartedAt, preserved.CompletedAt = before.StartedAt, before.CompletedAt
			preserved.Status, preserved.Ready, preserved.Version, preserved.UpdatedAt = before.Status, before.Ready, before.Version, before.UpdatedAt
			preserved.DependsOn, preserved.BlockedBy = before.DependsOn, before.BlockedBy
			if after.Version != expectedVersion || kind == "same_state" && !after.UpdatedAt.Equal(before.UpdatedAt) || kind != "same_state" && !after.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) || after.Ready != (kind == "same_state") {
				t.Fatal("installed status competition changed unrelated metadata or committed the wrong number of mutations")
			}
			switch kind {
			case "start":
				if after.Status != "in_progress" || len(after.DependsOn) != 0 || len(after.BlockedBy) != 0 {
					t.Fatal("same-version starts did not commit one valid start")
				}
			case "done":
				if after.Status != "done" || len(after.DependsOn) != 0 || len(after.BlockedBy) != 0 || after.StartedAt != nil {
					t.Fatal("same-version direct completions did not commit one completion with unknown duration")
				}
			case "distinct_targets":
				if (after.Status != "done" && after.Status != "in_progress") || len(after.DependsOn) != 0 || len(after.BlockedBy) != 0 {
					t.Fatal("distinct same-version targets did not retain one valid outcome")
				}
			case "same_state":
				if !reflect.DeepEqual(after, before) {
					t.Fatal("parallel same-state requests mutated task data")
				}
			case "dependency_edit_and_start":
				if after.Status == "todo" {
					if !slices.Equal(after.DependsOn, []string{prerequisiteID}) || !slices.Equal(after.BlockedBy, []string{prerequisiteID}) {
						t.Fatal("dependency winner did not leave todo work blocked by its unfinished prerequisite")
					}
				} else if after.Status != "in_progress" || len(after.DependsOn) != 0 || len(after.BlockedBy) != 0 {
					t.Fatal("dependency-edit/start competition gave active work an unfinished prerequisite")
				}
			}
			acceptanceLifecycleAttachmentUnchanged(t, cli, after, metadata, content)
			if prerequisite := cli.task(t, prerequisiteID); prerequisite.Status != "todo" || prerequisite.Version != 1 || !prerequisite.Ready {
				t.Fatal("installed status competition mutated its prerequisite")
			}
			if err := binaryAcceptance.update(func() {
				evidence.Race = &acceptanceLifecycleRaceEvidence{Kind: kind, Before: before, After: after, Requests: requests, Results: captured}
				scenario.AttachmentFiles = append(scenario.AttachmentFiles, acceptanceAttachmentEvidence{Path: metadata[0].Path, SizeBytes: len(content), SHA256: fmt.Sprintf("%x", sha256.Sum256(content))})
			}); err != nil {
				t.Fatal("cannot persist installed status race outcomes")
			}
			process.signal(t)
			process.stopped(t, 0)
		})
	}
}
