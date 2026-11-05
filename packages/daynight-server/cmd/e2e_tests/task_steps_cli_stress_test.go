//go:build stress

package e2e_tests

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
)

type taskStepsCLIStressCapture struct {
	file    *os.File
	written int64
}

func (capture *taskStepsCLIStressCapture) Write(data []byte) (int, error) {
	if int64(len(data)) > 128<<20-capture.written {
		return 0, errors.New("Steps stress stdout exceeded its separate 128 MiB capture bound")
	}
	n, err := capture.file.Write(data)
	capture.written += int64(n)
	return n, err
}

func TestInstalledCLITaskStepsCapacityStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("installed Steps capacity stress is opt-in outside routine CI")
	}
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_capacity", []string{"ST-V2", "ST-V9", "ST-V14"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		project := process.project(t, "Installed Steps capacity")
		task := process.task(t, project, "Legal complete Steps resource")
		stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
		header := model.TaskHeader{ProjectID: project.ID, ID: task.ID, Version: math.MaxInt64}
		rows := make([]model.TaskStep, 128)
		for index := range rows {
			rows[index] = model.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "<中文&>\u2028\u2029", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
		}
		_, base, err := taskcodec.EncodeCollection(header, rows)
		if err != nil {
			t.Fatal(err)
		}
		remaining := taskcodec.MaxEncodedBytes - len(base)
		for index := range rows {
			size := min(remaining, 524288)
			rows[index].Description = strings.Repeat("X", size)
			remaining -= size
			step := rows[index]
			fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, task.ID, step.ID, step.Position, step.Title, step.Description, step.Status, stamp)
		}
		if remaining != 0 {
			t.Fatal("legal maximum Steps fixture did not fill its encoded budget")
		}
		fixture.exec(t, `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64))
		// Observe the actual HTTP producer size without the routine 2 MiB response
		// helper. The CLI keeps its ordinary request and operation budgets.
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, process.origin+acceptanceTaskPath(task)+"/steps", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+process.token)
		request.Header.Set("X-Request-ID", "steps-capacity-producer")
		transport := &http.Transport{DisableKeepAlives: true}
		defer transport.CloseIdleConnections()
		response, err := (&http.Client{Transport: transport, Timeout: 45 * time.Second}).Do(request)
		if err != nil {
			t.Fatal("maximum Steps producer request failed")
		}
		wireBytes, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, taskcodec.MaxEncodedBytes+1))
		closeErr := response.Body.Close()
		if readErr != nil || closeErr != nil || response.StatusCode != http.StatusOK || wireBytes != taskcodec.MaxEncodedBytes {
			t.Fatalf("actual maximum producer bytes=%d status=%d", wireBytes, response.StatusCode)
		}
		syncContext, syncCancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := acceptanceEventually(syncContext, func() (bool, error) {
			return process.logs.matches(map[string]any{"type": "http_request", "request_id": "steps-capacity-producer"}), nil
		}); err != nil {
			syncCancel()
			t.Fatal("maximum producer log did not complete")
		}
		syncCancel()
		beforeRequests := len(taskStepsReadRequests(process))
		capturePath := filepath.Join(cli.root, "steps-capacity.stdout.json")
		file, err := os.OpenFile(capturePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal("cannot create owned stress stdout capture")
		}
		defer file.Close()
		capture := &taskStepsCLIStressCapture{file: file}
		stderr := &acceptanceCLIOutput{}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute+15*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, cli.receipt.NodePath, cli.receipt.EntryPath, "task", "step", "list", task.ID, "--project", project.ID, "--json")
		command.Dir, command.Env, command.WaitDelay = "/", cli.environment(), time.Second
		command.Cancel = func() error { return command.Process.Signal(os.Interrupt) }
		command.Stdout, command.Stderr = capture, stderr
		if err := command.Start(); err != nil {
			t.Fatal("cannot start installed Steps stress read")
		}
		if err := binaryAcceptance.update(func() { scenario.CLIProcessesStarted++ }); err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			t.Fatal("cannot persist installed stress process receipt")
		}
		runErr := command.Wait()
		if err := binaryAcceptance.update(func() { scenario.CLIProcessesReaped++ }); err != nil {
			t.Fatal("cannot persist installed stress process cleanup")
		}
		var exitError *exec.ExitError
		if runErr != nil && !errors.As(runErr, &exitError) {
			t.Fatalf("installed Steps stress read execution failed: %v", runErr)
		}
		if ctx.Err() != nil || command.ProcessState.ExitCode() != 0 || stderr.Len() != 0 || capture.written <= 4<<20 {
			t.Fatalf("installed maximum read failed: exit=%d bytes=%d stderr=%s", command.ProcessState.ExitCode(), capture.written, stderr.String())
		}
		requests := taskStepsReadRequests(process)
		if len(requests) != beforeRequests+1 || requests[beforeRequests] != "GET /api/v1/projects/{projectId}/tasks/{taskId}/steps" {
			t.Fatal("maximum explicit-project read made hidden requests")
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		decoder := json.NewDecoder(file)
		var resource api.StepsResource
		if err := decoder.Decode(&resource); err != nil {
			t.Fatal("maximum installed CLI output is not one complete JSON resource", err)
		}
		if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
			t.Fatal("maximum installed CLI output has trailing data")
		}
		if resource.ProjectID != project.ID || resource.TaskID != task.ID || resource.Version != math.MaxInt64 || len(resource.Steps) != len(rows) {
			t.Fatal("maximum installed CLI output lost scope, exact int64 or complete collection")
		}
		for index, expected := range rows {
			actual := resource.Steps[index]
			if actual.ID != expected.ID || actual.Title != expected.Title || actual.Description != expected.Description || actual.Status != expected.Status || actual.CreatedAt != stamp || actual.UpdatedAt != stamp {
				t.Fatalf("maximum installed CLI output altered or truncated Step %d", index)
			}
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		digest := sha256.New()
		if hashed, err := io.Copy(digest, file); err != nil || hashed != capture.written {
			t.Fatal("cannot hash complete installed CLI stress output")
		}
		t.Logf("Actual service resource=%d bytes; installed CLI JSON=%d bytes sha256=%x; all %d complete records and exact int64 retained", wireBytes, capture.written, digest.Sum(nil), len(rows))
		process.signal(t)
		process.stopped(t, 0)
	})
}
