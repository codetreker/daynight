package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	workerwire "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func inspectConfigAtLimit(t *testing.T) []byte {
	t.Helper()
	args := make([]string, 8)
	for n := range args {
		args[n] = strings.Repeat("a", 4096)
	}
	projects := make([]map[string]any, 128)
	for n := range projects {
		projects[n] = map[string]any{"projectId": fmt.Sprintf("00000000-0000-4000-8000-%012x", n+1), "nativeOverrides": map[string]any{"args": args}}
	}
	document := map[string]any{"maxConcurrent": 1, "pollIntervalMs": 1000, "recoveryLimit": 0, "native": map[string]any{"agent": "codex", "model": nil, "args": []string{}}, "projects": projects}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := worker.ParseWorkerConfiguration(raw)
	if err != nil {
		t.Fatal(err)
	}
	n, err := workerwire.EncodeConfiguration(io.Discard, cfg, 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	excess := n - worker.MaxConfigurationJSONBytes
	tail := append([]string{}, args...)
	for k := len(tail) - 1; k >= 0 && excess > 0; k-- {
		cut := min(excess, int64(len(tail[k])-1))
		tail[k] = tail[k][:len(tail[k])-int(cut)]
		excess -= cut
	}
	if excess != 0 {
		t.Fatal("cannot pad fixture")
	}
	projects[127]["nativeOverrides"] = map[string]any{"args": tail}
	raw, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err = worker.ParseWorkerConfiguration(raw)
	if err != nil {
		t.Fatal(err)
	}
	n, err = workerwire.EncodeConfiguration(io.Discard, cfg, worker.MaxConfigurationJSONBytes)
	if err != nil || n != worker.MaxConfigurationJSONBytes {
		t.Fatalf("configuration size %d: %v", n, err)
	}
	return raw
}
func inspectTelemetry(t *testing.T) []byte {
	t.Helper()
	now := time.Now().UTC()
	name := "0.9.5"
	report := model.WorkerTelemetry{Machine: model.WorkerMachine{ID: "00000000-0000-4000-8000-000000000004", Name: "worker"}, Platform: model.PlatformLinux, WorkingDirectory: "/work", SampledAt: now,
		OS:       model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: now, Value: &model.WorkerOS{Type: "Linux", Release: "6", Version: "kernel", Arch: "arm64"}},
		CPU:      model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: now, Value: &model.WorkerCPU{Model: "CPU", LogicalProcessors: 4, UsagePercent: 12}},
		Memory:   model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: now, Value: &model.WorkerMemory{UsedBytes: 4, TotalBytes: 8}},
		Disk:     model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: now, Value: &model.WorkerDisk{AvailableBytes: 8, TotalBytes: 16}},
		Versions: model.WorkerVersions{Daynight: "1", Herdr: model.WorkerProbe[string]{State: "ok", CheckedAt: now, Value: &name}, Codex: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}, Copilot: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}}}
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func inspectEvidence(t *testing.T, db *postgres.Store, root string) (string, string) {
	t.Helper()
	var digest string
	err := db.Pool.QueryRow(t.Context(), `SELECT md5(
      coalesce((SELECT string_agg(row_to_json(t)::text,'' ORDER BY id) FROM tasks t),'') ||
      coalesce((SELECT string_agg(row_to_json(p)::text,'' ORDER BY task_id,name) FROM task_properties p),'') ||
      coalesce((SELECT string_agg(row_to_json(s)::text,'' ORDER BY task_id,id) FROM task_steps s),'') ||
      coalesce((SELECT string_agg(row_to_json(a)::text,'' ORDER BY task_id,path) FROM task_attachments a),'') ||
      coalesce((SELECT string_agg(row_to_json(w)::text,'' ORDER BY user_id,worker_id) FROM workers w),'') ||
      coalesce((SELECT string_agg(row_to_json(p)::text,'' ORDER BY id) FROM projects p),'') ||
      coalesce((SELECT string_agg(row_to_json(u)::text,'' ORDER BY id) FROM users u),'') ||
      coalesce((SELECT string_agg(row_to_json(t)::text,'' ORDER BY id) FROM teams t),''))`).Scan(&digest)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.New()
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		io.WriteString(h, relative)
		if !entry.IsDir() {
			f, e := os.Open(path)
			if e != nil {
				return e
			}
			_, e = io.Copy(h, f)
			return errorsJoin(e, f.Close())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return digest, fmt.Sprintf("%x", h.Sum(nil))
}
func errorsJoin(a, b error) error {
	if a != nil {
		return a
	}
	return b
}
func reportLines(t *testing.T, data []byte) []map[string]any {
	t.Helper()
	var records []map[string]any
	s := bufio.NewScanner(bytes.NewReader(data))
	s.Buffer(make([]byte, 1024), 16<<10)
	for s.Scan() {
		var v map[string]any
		if err := json.Unmarshal(s.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		records = append(records, v)
	}
	if err := s.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}
func TestInputLimitsInspectionPostgresInventory(t *testing.T) {
	values := processAPIEnvironment(t)
	ctx := t.Context()
	db, err := postgres.Open(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const project = "00000000-0000-4000-8000-000000000001"
	const task = "00000000-0000-4000-8000-000000000002"
	const owner = "00000000-0000-4000-8000-000000000003"
	const workerID = "00000000-0000-4000-8000-000000000004"
	cfg := inspectConfigAtLimit(t)
	telemetry := inspectTelemetry(t)
	execSQL := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	execSQL(`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'identity',now(),now())`, owner)
	execSQL(`INSERT INTO teams(id,personal_user_id) VALUES('00000000-0000-4000-8000-000000000005',$1)`, owner)
	execSQL(`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','https://example.test/repo')`, project)
	execSQL(`INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'Title','Description')`, task, project)
	execSQL(`INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused',repeat(' ',100000)||'false')`, task)
	execSQL(`INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'00000001',0,'Step','Description','todo',now(),now())`, task)
	execSQL(`INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'maximum.bin','application/octet-stream',$3)`, project, task, attachment.MaxContentBytes)
	_, err = db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration) VALUES($1,$2,now(),now(),$3::jsonb,'{"state":"unavailable","items":[]}',1,now(),$4::jsonb)`, owner, workerID, telemetry, cfg)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(values["DAYNIGHT_STORAGE_ROOT"], attachment.Bucket, attachment.TaskStoragePath(project, task), "maximum.bin")
	if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, bytes.Repeat([]byte("x"), attachment.MaxContentBytes), 0600); err != nil {
		t.Fatal(err)
	}
	beforeDB, beforeFiles := inspectEvidence(t, db, values["DAYNIGHT_STORAGE_ROOT"])
	source := inspectionSource{SHA: strings.Repeat("a", 40)}
	var output bytes.Buffer
	if err = inspectInputLimits(ctx, values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_STORAGE_ROOT"], &output, source); err != nil {
		t.Fatalf("valid inventory: %v %s", err, output.String())
	}
	lines := reportLines(t, output.Bytes())
	if strings.Contains(output.String(), "Description") {
		t.Fatal("report leaked resource text")
	}
	if len(lines) != 2 || lines[1]["clear"] != true || lines[1]["complete"] != true {
		t.Fatalf("valid summary: %#v", lines)
	}
	afterDB, afterFiles := inspectEvidence(t, db, values["DAYNIGHT_STORAGE_ROOT"])
	if beforeDB != afterDB || beforeFiles != afterFiles {
		t.Fatal("valid inventory mutated fixture")
	}
	execSQL(`INSERT INTO tasks(id,project_id,title,deleted_at) VALUES('00000000-0000-4000-8000-000000000006',$1,repeat('x',1025),now())`, project)
	execSQL(`INSERT INTO task_properties(task_id,name,value) VALUES('00000000-0000-4000-8000-000000000006','paused',repeat(' ',8388609)||'true')`)
	execSQL(`INSERT INTO task_properties(task_id,name,value) VALUES('00000000-0000-4000-8000-000000000006','pullRequests','[{"url":"'||repeat('<',1500)||'","title":"x"}]')`)
	execSQL(`UPDATE task_attachments SET size_bytes=1 WHERE task_id=$1`, task)
	execSQL(`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) SELECT $1,gen_random_uuid(),now(),now(),$2::jsonb,'{"state":"unavailable","items":[]}' FROM generate_series(1,100)`, owner, telemetry)
	beforeDB, beforeFiles = inspectEvidence(t, db, values["DAYNIGHT_STORAGE_ROOT"])
	output.Reset()
	if err = inspectInputLimits(ctx, values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_STORAGE_ROOT"], &output, source); err == nil {
		t.Fatal("noncompliant inventory cleared")
	}
	lines = reportLines(t, output.Bytes())
	wanted := map[string]bool{"title": false, "property": false, "sizeBytes": false, "activeWorkers": false, "properties.pullRequests": false}
	for _, v := range lines {
		if v["type"] == "finding" {
			if key, ok := v["field"].(string); ok {
				if _, exists := wanted[key]; exists {
					wanted[key] = true
				}
			}
		}
	}
	for name, found := range wanted {
		if !found {
			t.Fatalf("missing %s: %s", name, output.String())
		}
	}
	if lines[len(lines)-1]["clear"] != false || lines[len(lines)-1]["complete"] != false {
		t.Fatalf("invalid summary: %s", output.String())
	}
	afterDB, afterFiles = inspectEvidence(t, db, values["DAYNIGHT_STORAGE_ROOT"])
	if beforeDB != afterDB || beforeFiles != afterFiles {
		t.Fatal("blocked inventory mutated fixture")
	}
	if strings.Contains(output.String(), strings.Repeat("<", 30)) || strings.Contains(output.String(), strings.Repeat("x", 30)) {
		t.Fatal("report leaked source content")
	}
	if err = os.Rename(file, file+".unavailable"); err != nil {
		t.Fatal(err)
	}
	beforeDB, beforeFiles = inspectEvidence(t, db, values["DAYNIGHT_STORAGE_ROOT"])
	output.Reset()
	if err = inspectInputLimits(ctx, values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_STORAGE_ROOT"], &output, source); err == nil {
		t.Fatal("missing file cleared")
	}
	lines = reportLines(t, output.Bytes())
	if lines[len(lines)-1]["clear"] != false || lines[len(lines)-1]["complete"] != false {
		t.Fatalf("missing-file summary: %s", output.String())
	}
	afterDB, afterFiles = inspectEvidence(t, db, values["DAYNIGHT_STORAGE_ROOT"])
	if beforeDB != afterDB || beforeFiles != afterFiles {
		t.Fatal("failed inventory mutated fixture")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	output.Reset()
	if err = inspectInputLimits(canceled, values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_STORAGE_ROOT"], &output, source); err == nil {
		t.Fatal("canceled scan cleared")
	}
	if strings.Contains(output.String(), `"clear":true`) {
		t.Fatal("canceled report claims clear")
	}
}
