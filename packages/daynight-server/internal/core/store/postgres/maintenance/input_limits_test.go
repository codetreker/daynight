package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5"
)

type inputVisitor struct {
	identity func(store.InputLimitsIdentity) error
	record   func(store.InputLimitsRecord) error
}

func (v inputVisitor) Identity(i store.InputLimitsIdentity) error {
	if v.identity != nil {
		return v.identity(i)
	}
	return nil
}
func (v inputVisitor) Record(r store.InputLimitsRecord) error {
	if v.record != nil {
		return v.record(r)
	}
	return nil
}

func TestInputLimitsSnapshotBoundedAndReadOnly(t *testing.T) {
	url := scopedDatabaseURL(t)
	ctx := t.Context()
	db, err := postgres.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES('00000000-0000-4000-8000-000000000001','project','repo');
	INSERT INTO tasks(id,project_id,title,description) VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','old','description');
	INSERT INTO task_properties(task_id,name,value) VALUES
	('00000000-0000-4000-8000-000000000002','atmax!',repeat('x',8388566)),
	('00000000-0000-4000-8000-000000000002','above!',repeat('x',8388567));`)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := OpenInputLimits(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	var serverAddress, serverPort, systemID string
	if err = db.Pool.QueryRow(ctx, `SELECT coalesce(host(inet_server_addr()),'unix'),coalesce(inet_server_port()::text,'unix'),(pg_control_system()).system_identifier::text`).Scan(&serverAddress, &serverPort, &systemID); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	err = reader.Scan(ctx, inputVisitor{identity: func(i store.InputLimitsIdentity) error {
		if i.Snapshot == "" || i.Schema == "" || i.DatabaseOID == "" || i.ServerAddress != serverAddress || i.ServerPort != serverPort || i.SystemIdentifier != systemID || len(i.Relations) != 14 {
			t.Fatalf("identity: %#v", i)
		}
		_, err := db.Pool.Exec(ctx, `UPDATE projects SET name='new' WHERE id='00000000-0000-4000-8000-000000000001'`)
		return err
	}, record: func(r store.InputLimitsRecord) error {
		switch r.Kind {
		case "task":
			if r.CandidateComplete || r.Fields["title"].Bytes != 3 {
				t.Fatalf("task budget: %#v", r)
			}
			seen["task"] = true
		case "project":
			if *r.Fields["name"].Value != "project" {
				t.Fatalf("snapshot changed: %#v", r)
			}
			seen["project"] = true
		case "property":
			name := r.Fields["name"]
			if name.Value == nil {
				t.Fatal("name must fit")
			}
			value := r.Fields["value"]
			if *name.Value == "atmax!" && (value.Value == nil || !r.CandidateComplete || len(*value.Value) != 8388566) {
				t.Fatal("at-limit candidate withheld")
			}
			if *name.Value == "above!" && (value.Value != nil || r.CandidateComplete || value.Bytes != 8388567) {
				t.Fatal("over-limit candidate read")
			}
			seen[*name.Value] = true
		}
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"task", "project", "atmax!", "above!"} {
		if !seen[key] {
			t.Fatalf("missing %s", key)
		}
	}
	var title string
	if err = db.Pool.QueryRow(ctx, `SELECT title FROM tasks WHERE id='00000000-0000-4000-8000-000000000002'`).Scan(&title); err != nil || title != "old" {
		t.Fatalf("task changed: %q %v", title, err)
	}
	stop := errors.New("visitor stopped")
	if err = reader.Scan(ctx, inputVisitor{identity: func(store.InputLimitsIdentity) error { return stop }}); !errors.Is(err, stop) {
		t.Fatalf("visitor error: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err = reader.Scan(canceled, inputVisitor{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

func TestInputProjectionHasExplicitBoundedColumns(t *testing.T) {
	for _, p := range inputProjections {
		metadata, candidate := projectionSQL(p), candidateSQL(p)
		if strings.Contains(strings.ToLower(metadata), "to_jsonb(") || !strings.Contains(candidate, "<= $2 LIMIT 1") || !strings.Contains(candidate, ".ctid=$1::tid") {
			t.Fatalf("unsafe projection %s: metadata=%s candidate=%s", p.kind, metadata, candidate)
		}
	}
}

func TestInputLimitsCompleteTaskAndActiveOwners(t *testing.T) {
	url := scopedDatabaseURL(t)
	ctx := t.Context()
	db, err := postgres.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES('00000000-0000-4000-8000-000000000001','project','repo');
	INSERT INTO tasks(id,project_id,title,description,deleted_at) VALUES
	('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','first','description',NULL),
	('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','deleted','description',now());
	INSERT INTO task_properties(task_id,name,value) VALUES('00000000-0000-4000-8000-000000000002','paused','false');
	INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',true);
	INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
	SELECT '00000000-0000-4000-8000-000000000004',gen_random_uuid(),now(),now(),'{}','{}' FROM generate_series(1,101);`)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := OpenInputLimits(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	tasks, workers, owners := 0, 0, 0
	err = reader.Scan(ctx, inputVisitor{record: func(r store.InputLimitsRecord) error {
		switch r.Kind {
		case "task":
			tasks++
			if !r.CandidateComplete {
				t.Fatal("complete task withheld")
			}
			if r.IDs["id"] == "00000000-0000-4000-8000-000000000002" {
				if r.Properties["paused"] != "false" || len(r.Dependencies) != 1 || len(r.ExternalDependencies) != 1 || len(r.BlockedBy) != 1 {
					t.Fatalf("task candidate: %#v", r)
				}
			} else if !r.Fields["deletedAt"].Present {
				t.Fatal("deleted task not scanned")
			}
		case "worker":
			workers++
		case "activeOwner":
			owners++
			if r.Numbers["count"] != 101 {
				t.Fatalf("active count: %v", r.Numbers)
			}
		}
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if tasks != 2 || workers != 101 || owners != 1 {
		t.Fatalf("visited tasks=%d workers=%d owners=%d", tasks, workers, owners)
	}
}

func TestInputLimitsTaskCompleteCandidateBoundary(t *testing.T) {
	url := scopedDatabaseURL(t)
	ctx := t.Context()
	db, err := postgres.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES('00000000-0000-4000-8000-000000000001','project','repo');
	INSERT INTO tasks(id,project_id,title,description,created_at,updated_at) VALUES
	('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','x','y','2026-01-01 00:00:00+00','2026-01-01 00:00:00+00'),
	('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','x','y','2026-01-01 00:00:00+00','2026-01-01 00:00:00+00');
	INSERT INTO task_properties(task_id,name,value) VALUES
	('00000000-0000-4000-8000-000000000002','p',repeat('x',8388475)),
	('00000000-0000-4000-8000-000000000003','p',repeat('x',8388476));`)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := OpenInputLimits(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	count := 0
	err = reader.Scan(ctx, inputVisitor{record: func(r store.InputLimitsRecord) error {
		if r.Kind != "task" {
			return nil
		}
		count++
		if r.IDs["id"] == "00000000-0000-4000-8000-000000000002" {
			if !r.CandidateComplete || len(r.Properties["p"]) != 8388475 {
				t.Fatalf("exact boundary rejected: %#v", r.Numbers)
			}
			var selected int64
			for _, f := range r.Fields {
				if f.Value != nil {
					selected += int64(len(*f.Value))
				}
			}
			selected += int64(len(r.IDs["id"]) + len(r.IDs["projectId"]) + len("p") + len(r.Properties["p"]))
			if selected != inputCandidateBytes {
				t.Fatalf("fixture selected %d bytes", selected)
			}
		} else if r.CandidateComplete {
			t.Fatal("boundary plus one was read")
		}
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("tasks: %d", count)
	}
}

func TestInputLimitsOrphansAndDatabaseFailure(t *testing.T) {
	url := scopedDatabaseURL(t)
	ctx := t.Context()
	db, err := postgres.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES('00000000-0000-4000-8000-000000000002','paused','false');
	INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003');
	INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','file','text/plain',1);
	INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES('00000000-0000-4000-8000-000000000002','00000001',0,'step','','todo',now(),now());`)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := OpenInputLimits(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	seen := map[string]bool{}
	err = reader.Scan(ctx, inputVisitor{record: func(r store.InputLimitsRecord) error {
		switch r.Kind {
		case "orphanProperty", "orphanDependency", "orphanAttachment":
			seen[r.Kind] = true
		case "step":
			if r.Fields["version"].Present || r.IDs["projectId"] != "" {
				t.Fatal("orphan step acquired a parent")
			}
			seen["step"] = true
		}
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"orphanProperty", "orphanDependency", "orphanAttachment", "step"} {
		if !seen[kind] {
			t.Fatalf("missing %s", kind)
		}
	}
	if _, err = db.Pool.Exec(ctx, `DROP TABLE private_upload_chunks`); err != nil {
		t.Fatal(err)
	}
	err = reader.Scan(ctx, inputVisitor{})
	if err == nil || !strings.Contains(err.Error(), "private_upload_chunks") {
		t.Fatalf("missing relation: %v", err)
	}
}

// Metadata is yielded one item at a time, so one encoded item is also the
// complete metadata batch. The worst-case escaped short key stays below both
// the item and batch budgets.
func TestInputLimitsMetadataKeyBudget(t *testing.T) {
	value := strings.Repeat("<", 1024)
	r := store.InputLimitsRecord{Kind: "property", IDs: map[string]string{"taskId": "00000000-0000-4000-8000-000000000001"}, Fields: map[string]store.InputLimitsField{
		"name":  {Present: true, Bytes: int64(len(value)), Characters: 1024, Value: &value, SHA256: strings.Repeat("a", 64)},
		"value": {Present: true, Bytes: 8388609, Characters: 8388609},
	}}
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > 8<<10 || len(data) > 64<<10 {
		t.Fatalf("metadata item/batch = %d bytes", len(data))
	}
}

// Query tracing verifies that metadata retrieval never asks the driver for a
// second row and that each admitted candidate is a separate bounded query.
type inputQueryTrace struct{ queries []string }

func (t *inputQueryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	t.queries = append(t.queries, data.SQL)
	return ctx
}
func (*inputQueryTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestInputLimitsQueriesOneCandidateAtATime(t *testing.T) {
	url := scopedDatabaseURL(t)
	ctx := t.Context()
	setup, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Close(context.Background())
	_, err = setup.Exec(ctx, `CREATE TABLE task_properties(task_id uuid NOT NULL, name text NOT NULL, value text NOT NULL);
	INSERT INTO task_properties VALUES
	('00000000-0000-4000-8000-000000000001','a',repeat('x',8388571)),
	('00000000-0000-4000-8000-000000000001','b',repeat('x',8388572));`)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	trace := &inputQueryTrace{}
	cfg.Tracer = trace
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	p := inputProjections[0]
	count := 0
	err = scanProjection(ctx, tx, inputVisitor{record: func(r store.InputLimitsRecord) error {
		count++
		if count == 1 && (!r.CandidateComplete || len(*r.Fields["value"].Value) != 8388571) {
			t.Fatal("exact candidate missing")
		}
		if count == 2 && (r.CandidateComplete || r.Fields["value"].Value != nil) {
			t.Fatal("over-budget candidate read")
		}
		return nil
	}}, p)
	if err != nil {
		t.Fatal(err)
	}
	fetches, candidates := 0, 0
	for _, query := range trace.queries {
		if strings.HasPrefix(query, "FETCH ") {
			fetches++
			if !strings.Contains(query, "FETCH FORWARD 1 ") {
				t.Fatalf("unbounded metadata: %s", query)
			}
		}
		if strings.HasPrefix(query, "SELECT ") {
			candidates++
			if !strings.Contains(query, "<= $2 LIMIT 1") {
				t.Fatalf("unbounded candidate: %s", query)
			}
		}
	}
	if count != 2 || fetches != 3 || candidates != 1 {
		t.Fatalf("records=%d fetches=%d candidates=%d; queries=%v", count, fetches, candidates, trace.queries)
	}
	stop := errors.New("visitor stopped")
	if err := scanProjection(ctx, tx, inputVisitor{record: func(store.InputLimitsRecord) error { return stop }}, p); !errors.Is(err, stop) {
		t.Fatalf("visitor cause: %v", err)
	}
	if err := scanProjection(ctx, tx, inputVisitor{}, p); err != nil {
		t.Fatalf("cursor was not closed after visitor error: %v", err)
	}
}

func TestInputLimitsTaskFailuresPreserveCauses(t *testing.T) {
	stop := errors.New("visitor stopped")
	for _, tc := range []struct {
		name, mutation, phase string
		visitor               inputVisitor
	}{
		{name: "metadata query failure", mutation: `ALTER TABLE task_dependencies RENAME TO inaccessible_dependencies`, phase: "task metadata"},
		{name: "invalid task candidate", mutation: `ALTER TABLE tasks ALTER COLUMN status DROP NOT NULL; UPDATE tasks SET status=NULL`, phase: "task candidate"},
		{name: "missing property value", mutation: `ALTER TABLE task_properties ALTER COLUMN value DROP NOT NULL; INSERT INTO task_properties(task_id,name,value) VALUES ('00000000-0000-4000-8000-000000000002','paused',NULL)`, phase: "task property"},
		{name: "missing dependency state", mutation: `ALTER TABLE task_dependencies ALTER COLUMN external DROP NOT NULL; INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',NULL)`, phase: "task dependency"},
		{name: "visitor refusal", phase: "visitor stopped", visitor: inputVisitor{record: func(store.InputLimitsRecord) error { return stop }}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			url := scopedDatabaseURL(t)
			ctx := t.Context()
			db, err := postgres.Open(ctx, url)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			_, err = db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES('00000000-0000-4000-8000-000000000001','project','repo');
			INSERT INTO tasks(id,project_id,title,description) VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','task','description')`)
			if err != nil {
				t.Fatal(err)
			}
			if tc.mutation != "" {
				if _, err = db.Pool.Exec(ctx, tc.mutation); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			err = scanInputTasks(ctx, tx, tc.visitor)
			if err == nil || !strings.Contains(err.Error(), tc.phase) {
				t.Fatalf("phase: %v", err)
			}
			if tc.name == "visitor refusal" && !errors.Is(err, stop) {
				t.Fatalf("lost visitor cause: %v", err)
			}
		})
	}
}
