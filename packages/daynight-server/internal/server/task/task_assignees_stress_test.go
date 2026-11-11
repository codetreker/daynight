//go:build stress

package task_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type assigneeMeasuredQuery struct {
	SQL  string
	Args []any
}

type assigneeQueryRecorder struct {
	mu      sync.Mutex
	queries []assigneeMeasuredQuery
}

func (r *assigneeQueryRecorder) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.queries = append(r.queries, assigneeMeasuredQuery{SQL: data.SQL, Args: append([]any{}, data.Args...)})
	return ctx
}

func (*assigneeQueryRecorder) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (r *assigneeQueryRecorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.queries = nil
}

func (r *assigneeQueryRecorder) selected(t *testing.T, directory bool) assigneeMeasuredQuery {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	var found []assigneeMeasuredQuery
	for _, query := range r.queries {
		matches := strings.Contains(query.SQL, "FROM candidate_ids candidate") || strings.Contains(query.SQL, "FROM unnest($2::uuid[]) requested")
		if !directory {
			matches = strings.Contains(query.SQL, "FROM task_resource_rows t") && strings.Contains(query.SQL, "ORDER BY t.created_at, t.id LIMIT")
		}
		if matches {
			found = append(found, query)
		}
	}
	if len(found) != 1 {
		t.Fatalf("expected one actual production query, captured %d", len(found))
	}
	return found[0]
}

func assigneePlanIndexes(value any, result map[string]bool) {
	switch node := value.(type) {
	case map[string]any:
		if index, ok := node["Index Name"].(string); ok {
			result[index] = true
		}
		for _, child := range node {
			assigneePlanIndexes(child, result)
		}
	case []any:
		for _, child := range node {
			assigneePlanIndexes(child, result)
		}
	}
}

func TestStressTaskAssigneeProductionQuerySample(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only and cannot run in CI")
	}
	base := projectTestStore(t)
	recorder := &assigneeQueryRecorder{}
	config := base.Pool.Config()
	config.ConnConfig.Tracer = recorder
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	database := &postgres.Store{Pool: pool}
	handler := projectTestHandler(t, database, io.Discard)
	project := decodeResponse[api.Project](t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Task project", RepoURL: "https://github.com/example/tasks", ExpectedUserID: handler.principal.UserID})), http.StatusCreated)
	ids := []string{handler.principal.UserID}
	for len(ids) < 100 {
		ids = append(ids, uuid.NewString())
	}
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,name,avatar_url,created_at,updated_at)
		SELECT person,person::text,'Sample person',NULL,now(),now() FROM unnest($1::uuid[]) person`, ids[1:]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role)
		SELECT $1,person,'member' FROM unnest($2::uuid[]) person`, project.ID, ids[1:]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,assigned_to,created_at,updated_at,deleted_at)
		SELECT md5('assignee-sample-'||item)::uuid,$1,'Sample task',
		CASE WHEN item%2=0 THEN NULL ELSE ($2::uuid[])[((item/2)%100)+1] END,
		'2026-10-01'::timestamptz+item*interval '1 microsecond',
		'2026-10-01'::timestamptz+item*interval '1 microsecond',
		CASE WHEN item%40=0 THEN '2026-10-02'::timestamptz ELSE NULL END
		FROM generate_series(1,10000) item`, project.ID, ids); err != nil {
		t.Fatal(err)
	}
	var former []string
	for index := 1; index < len(ids); index += 2 {
		former = append(former, ids[index])
	}
	if _, err := pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=ANY($2::uuid[])`, project.ID, former); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE tasks; ANALYZE users; ANALYZE project_grants; ANALYZE task_properties; ANALYZE task_dependencies`); err != nil {
		t.Fatal(err)
	}
	var taskCount, deletedCount, unassignedCount, oldIndexBytes, newIndexBytes int64
	if err := pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE deleted_at IS NOT NULL),
		count(*) FILTER (WHERE assigned_to IS NULL),
		pg_relation_size('tasks_project_assigned_to_created_id'),
		pg_relation_size('tasks_project_assigned_to_created_id_all')
		FROM tasks WHERE project_id=$1`, project.ID).Scan(&taskCount, &deletedCount, &unassignedCount, &oldIndexBytes, &newIndexBytes); err != nil {
		t.Fatal(err)
	}
	query := url.Values{}
	for _, id := range ids {
		query.Add("userId", id)
	}
	measurements := []map[string]any{}
	for _, sample := range []struct {
		name, path string
		directory  bool
		want       int
	}{
		{"named", taskCollection(project.ID) + "?limit=100&assignedTo=" + ids[17], false, 50},
		{"unassigned", taskCollection(project.ID) + "?limit=100&assignedTo=unassigned", false, 100},
		{"catalogue", taskAssigneesPath(project.ID), true, 100},
		{"resolve-one", taskAssigneesPath(project.ID) + assigneeHTTPQuery(ids[17]), true, 1},
		{"resolve-hundred", taskAssigneesPath(project.ID) + "?" + query.Encode(), true, 100},
	} {
		recorder.reset()
		start := time.Now()
		response := projectRequest(handler, http.MethodGet, sample.path, "")
		duration := time.Since(start)
		if response.Code != http.StatusOK {
			t.Fatalf("sample %s failed: %d %s", sample.name, response.Code, response.Body)
		}
		var body struct {
			Items []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.Items) != sample.want {
			t.Fatalf("sample %s row count: %d want %d, %v", sample.name, len(body.Items), sample.want, err)
		}
		captured := recorder.selected(t, sample.directory)
		var plan []byte
		if err := base.Pool.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+captured.SQL, captured.Args...).Scan(&plan); err != nil {
			t.Fatal(err)
		}
		var parsed any
		if err := json.Unmarshal(plan, &parsed); err != nil {
			t.Fatal(err)
		}
		indexes := map[string]bool{}
		assigneePlanIndexes(parsed, indexes)
		if sample.name == "named" || strings.HasPrefix(sample.name, "resolve-") {
			if !indexes["tasks_project_assigned_to_created_id_all"] {
				t.Fatalf("sample %s did not use the native project/assignment index: %s", sample.name, plan)
			}
		}
		measurements = append(measurements, map[string]any{
			"name": sample.name, "responseItems": len(body.Items), "responseBytes": response.Body.Len(),
			"httpDurationNanoseconds": duration.Nanoseconds(), "productionQuerySha256": fmt.Sprintf("%x", sha256.Sum256([]byte(captured.SQL))),
			"queryPlan": json.RawMessage(plan), "indexes": indexes,
		})
	}
	root, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Fatal(err)
	}
	repository := strings.TrimSpace(string(root))
	source := func(arguments ...string) string {
		t.Helper()
		command := exec.Command("git", arguments...)
		command.Dir = repository
		output, err := command.Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(output))
	}
	evidence := map[string]any{
		"tasks": 10000, "people": 100, "scope": "isolated PostgreSQL, actual HTTP resources and traced production SQL",
		"sampleDistribution": map[string]any{"tasks": taskCount, "deleted": deletedCount, "unassigned": unassignedCount},
		"indexBytes":         map[string]any{"tasks_project_assigned_to_created_id": oldIndexBytes, "tasks_project_assigned_to_created_id_all": newIndexBytes},
		"sourceGitSha":       source("rev-parse", "HEAD"), "sourceDirty": source("status", "--porcelain") != "",
		"measurements": measurements, "limit": "Source-bound sample; no latency threshold, production capacity, or write cost claim.",
	}
	data, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(repository, ".tmp", "perf")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assignee-query-sample.json"), append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
