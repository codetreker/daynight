package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func acceptanceMigrationCommand(t *testing.T, fixture *acceptanceFixture, arguments ...string) service.AttachmentMigrationSummary {
	t.Helper()
	application := fmt.Sprintf("%s_migration_%d", fixture.schema, len(fixture.applications)+1)
	fixture.applications = append(fixture.applications, application)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binaryAcceptance.Binary, append([]string{"migrate-attachment-layout"}, arguments...)...)
	command.Env = acceptanceEnvironment(map[string]string{"DAYNIGHT_DATABASE_URL": fixture.url(t, application), "DAYNIGHT_STORAGE_ROOT": fixture.storageRoot,
		"DAYNIGHT_PUBLIC_ORIGIN": "invalid", "DAYNIGHT_UNIAUTH_URL": "invalid", "DAYNIGHT_UNIAUTH_APP_ID": "", "DAYNIGHT_UNIAUTH_APP_SECRET": "", "DAYNIGHT_LISTEN_ADDR": "invalid"})
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr, command.WaitDelay = &stdout, &stderr, time.Second
	if err := command.Start(); err != nil {
		t.Fatal("cannot start owned attachment maintenance process")
	}
	if err := binaryAcceptance.update(func() { fixture.scenario.ProcessesStarted++ }); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal("cannot persist maintenance process start")
	}
	err := command.Wait()
	if updateErr := binaryAcceptance.update(func() { fixture.scenario.ProcessesReaped++ }); updateErr != nil {
		t.Fatal("cannot persist maintenance process completion")
	}
	if err != nil {
		t.Fatalf("attachment maintenance process failed: %v\n%s", err, stderr.String())
	}
	var result service.AttachmentMigrationSummary
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || result.OperationID == "" || result.ManifestPath == "" {
		t.Fatalf("maintenance stdout is not one complete result: %s, %v", stdout.String(), err)
	}
	for _, line := range strings.Split(strings.TrimSpace(stderr.String()), "\n") {
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) != nil || event["component"] != "attachment_layout_migration" || event["phase"] == "listening" {
			t.Fatalf("maintenance diagnostics are invalid or started HTTP: %s", line)
		}
	}
	return result
}

func acceptanceMigrateAttachmentLayout(t *testing.T, fixture *acceptanceFixture) {
	t.Helper()
	plan := acceptanceMigrationCommand(t, fixture, "plan")
	if plan.Phase != "planned" || plan.ReceiptPath != nil {
		t.Fatal("attachment migration plan returned a completion receipt")
	}
	applied := acceptanceMigrationCommand(t, fixture, "apply", "--operation-id", plan.OperationID)
	if applied.Phase != "complete" || applied.ReceiptPath == nil || applied.OperationID != plan.OperationID || applied.TaskCount != plan.TaskCount || applied.FileCount != plan.FileCount || applied.TotalBytes != plan.TotalBytes {
		t.Fatal("attachment migration did not complete the planned inventory")
	}
}

func TestAttachmentLayoutMigrationProcessAcceptance(t *testing.T) {
	acceptanceCase(t, "offline_attachment_layout_migration_process_restart", []string{"FA1", "FA3", "FA9", "FA11"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		project := process.project(t, "Legacy attachment storage")
		task := process.task(t, project, "Preserved content")
		process.signal(t)
		process.stopped(t, 0)
		content := []byte{0, 255, 'a', '\n', 1}
		legacy := filepath.Join(fixture.storageRoot, "task-attachments", task.ID, "docs", "legacy.bin")
		if err := os.MkdirAll(filepath.Dir(legacy), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(legacy, content, 0o600); err != nil {
			t.Fatal(err)
		}
		fixture.exec(t, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES ($1,$2,'docs/legacy.bin','application/octet-stream',$3)`, project.ID, task.ID, len(content))
		var before string
		if err := fixture.admin.QueryRow(context.Background(), `SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path)::text FROM task_attachments a`).Scan(&before); err != nil {
			t.Fatal(err)
		}
		ledger := acceptanceMigrationLedger(t, fixture)
		plan := acceptanceMigrationCommand(t, fixture, "plan")
		applied := acceptanceMigrationCommand(t, fixture, "apply", "--operation-id", strings.ToUpper(plan.OperationID))
		if applied.Phase != "complete" || applied.TaskCount != 1 || applied.FileCount != 1 || applied.TotalBytes != int64(len(content)) {
			t.Fatal("actual maintenance command returned an incorrect inventory")
		}
		verified := acceptanceMigrationCommand(t, fixture, "resume", "--operation-id", plan.OperationID)
		if !reflect.DeepEqual(applied, verified) {
			t.Fatal("completed maintenance verification changed its receipt")
		}
		var after string
		if err := fixture.admin.QueryRow(context.Background(), `SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path)::text FROM task_attachments a`).Scan(&after); err != nil || before != after || !reflect.DeepEqual(ledger, acceptanceMigrationLedger(t, fixture)) {
			t.Fatal("offline layout conversion changed PostgreSQL metadata or the SQL migration ledger")
		}
		physical := filepath.Join(fixture.storageRoot, "task-attachments", project.ID, task.ID[:2], task.ID, "docs", "legacy.bin")
		actual, err := os.ReadFile(physical)
		if err != nil || !bytes.Equal(actual, content) {
			t.Fatal("maintenance did not preserve binary content at the exact new address")
		}
		process = fixture.launch(t, nil).started(t)
		response := process.request(context.Background(), http.MethodGet, "/api/v1/projects/"+project.ID+"/tasks/"+task.ID+"/attachments/files/docs/legacy.bin", nil, "migrated-attachment")
		if response.err != nil || response.status != http.StatusOK || !bytes.Equal(response.body, content) {
			t.Fatalf("restarted service did not read migrated bytes through the original URL: status=%d error=%v", response.status, response.err)
		}
		if err := binaryAcceptance.update(func() {
			scenario.AttachmentFiles = append(scenario.AttachmentFiles, acceptanceAttachmentEvidence{Path: "docs/legacy.bin", SizeBytes: len(content), SHA256: fmt.Sprintf("%x", sha256.Sum256(content))})
		}); err != nil {
			t.Fatal(err)
		}
		process.signal(t)
		process.stopped(t, 0)
	})
}
