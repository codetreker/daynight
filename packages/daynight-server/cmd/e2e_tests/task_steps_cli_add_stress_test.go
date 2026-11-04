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
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
	"github.com/google/uuid"
)

func taskStepsAddStressRun(t *testing.T, cli *acceptanceCLI, arguments ...string) (int, *os.File, int64, string) {
	t.Helper()
	file, err := os.CreateTemp(cli.root, "steps-add-*.stdout.json")
	if err != nil {
		t.Fatal("cannot create owned Add stress capture")
	}
	t.Cleanup(func() {
		if err := file.Close(); err != nil {
			t.Error("cannot close owned Add stress capture")
		}
	})
	capture := &taskStepsCLIStressCapture{file: file}
	stderr := &acceptanceCLIOutput{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute+15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, cli.receipt.NodePath, append([]string{cli.receipt.EntryPath}, arguments...)...)
	command.Dir, command.Env, command.WaitDelay = "/", cli.environment(), time.Second
	command.Cancel = func() error { return command.Process.Signal(os.Interrupt) }
	command.Stdout, command.Stderr = capture, stderr
	if err := command.Start(); err != nil {
		t.Fatal("cannot start installed Add stress command")
	}
	if err := binaryAcceptance.update(func() { cli.scenario.CLIProcessesStarted++ }); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal("cannot persist installed Add stress process")
	}
	runErr := command.Wait()
	if err := binaryAcceptance.update(func() { cli.scenario.CLIProcessesReaped++ }); err != nil {
		t.Fatal("cannot persist installed Add stress cleanup")
	}
	var exitError *exec.ExitError
	if ctx.Err() != nil || runErr != nil && !errors.As(runErr, &exitError) {
		t.Fatalf("installed Add stress execution was not confirmed complete: %v", runErr)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	return command.ProcessState.ExitCode(), file, capture.written, stderr.String()
}

func taskStepsAddResponseFacts(t *testing.T, process *acceptanceProcess, requestID string) (int, int64) {
	t.Helper()
	process.logs.mu.Lock()
	defer process.logs.mu.Unlock()
	for _, event := range process.logs.events {
		if event["component"] == "task_step" && event["phase"] == "response" && event["request_id"] == requestID {
			if event["response_outcome"] != "written" {
				t.Fatal("capacity calibration producer response was not fully written")
			}
			status, ok := event["status"].(float64)
			if !ok {
				t.Fatal("capacity producer status missing")
			}
			written, ok := event["written_bytes"].(float64)
			if !ok {
				t.Fatal("capacity producer byte count missing")
			}
			return int(status), int64(written)
		}
	}
	t.Fatal("capacity calibration lacks the original UUID response facts")
	return 0, 0
}

func taskStepsAddCapacityDetail(t *testing.T, diagnostic, name string) int64 {
	t.Helper()
	match := regexp.MustCompile(name + `"?\s*[:=]\s*([0-9]+)`).FindStringSubmatch(diagnostic)
	if len(match) != 2 {
		t.Fatalf("known capacity diagnostic omitted %s", name)
	}
	value, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil {
		t.Fatal("capacity diagnostic byte value is not exact int64")
	}
	return value
}

func TestInstalledCLITaskStepsAddCapacityStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("installed Add capacity stress is opt-in outside routine CI")
	}
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_add_capacity", []string{"ST-V9", "ST-V11", "ST-V14"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		project := process.project(t, "Installed Add capacity")
		task := process.task(t, project, "Exact capacity candidate")
		stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
		header := core.TaskHeader{ProjectID: project.ID, ID: task.ID, Version: math.MaxInt64}
		rows := make([]core.TaskStep, 128)
		for index := range rows {
			rows[index] = core.TaskStep{ID: fmt.Sprintf("%08x", index), Position: int64(index), Title: "<中文&>\u2028\u2029", Status: core.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
		}
		candidate := append(append([]core.TaskStep{}, rows...), core.TaskStep{ID: "ffffffff", Position: 128, Title: "New <&> 中文", Status: core.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp})
		_, base, err := tasksteps.EncodeCollection(header, candidate)
		if err != nil {
			t.Fatal(err)
		}
		remaining := tasksteps.MaxEncodedBytes - len(base)
		for index := range rows {
			size := min(remaining, 524288)
			rows[index].Description = strings.Repeat("X", size)
			remaining -= size
			step := rows[index]
			fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, task.ID, step.ID, step.Position, step.Title, step.Description, step.Status, stamp)
		}
		if remaining != 0 {
			t.Fatal("Add capacity baseline did not fill candidate bytes")
		}
		snapshot := func() string {
			t.Helper()
			var state string
			if err := fixture.admin.QueryRow(context.Background(), `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&state); err != nil {
				t.Fatal(err)
			}
			return state
		}
		reset := func(padding int) {
			t.Helper()
			if padding < 0 {
				t.Fatal("negative capacity calibration padding")
			}
			fixture.exec(t, `DELETE FROM task_steps WHERE task_id=$1 AND id='ffffffff'`, task.ID)
			fixture.exec(t, `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64-1))
			fixture.exec(t, `UPDATE task_steps SET description=$2 WHERE task_id=$1 AND id='0000007f'`, task.ID, rows[127].Description+strings.Repeat("X", padding))
		}
		padding := 0
		history := make([]string, 0, 64)
		calibrate := func(target int64) (api.StepsResource, string) {
			t.Helper()
			for attempt := 0; attempt < 32; attempt++ {
				reset(padding)
				before := snapshot()
				mark := acceptanceAssignmentMark(t, process, project)
				code, file, stdoutBytes, diagnostic := taskStepsAddStressRun(t, cli, "task", "step", "add", task.ID, "--project", project.ID, "--if-version", "9223372036854775806", "--id", "FFFFFFFF", "--title", "New <&> 中文", "--json")
				requests := taskStepsAddRequestBudget(t, process, project, mark, "POST "+taskStepsCollectionRoute)
				requestID := requests[0].RequestID
				if _, err := uuid.Parse(requestID); err != nil {
					t.Fatal("capacity Add did not preserve original request UUID")
				}
				status, wireBytes := taskStepsAddResponseFacts(t, process, requestID)
				measured := int64(0)
				var resource api.StepsResource
				switch {
				case code == 0 && status == 201 && diagnostic == "":
					decoder := json.NewDecoder(file)
					if err := decoder.Decode(&resource); err != nil {
						t.Fatal("capacity Add output is incomplete/invalid JSON", err)
					}
					if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
						t.Fatal("capacity Add output contains trailing data")
					}
					if resource.ProjectID != project.ID || resource.TaskID != task.ID || resource.Version != math.MaxInt64 || len(resource.Steps) != 129 {
						t.Fatal("capacity Add receipt lost scope/version/count")
					}
					for index, expected := range rows {
						actual := resource.Steps[index]
						description := expected.Description
						if index == 127 {
							description += strings.Repeat("X", padding)
						}
						if actual.ID != expected.ID || actual.Title != expected.Title || actual.Description != description || actual.Status != expected.Status || actual.CreatedAt != stamp || actual.UpdatedAt != stamp {
							t.Fatalf("capacity Add changed existing Step %d", index)
						}
					}
					added := resource.Steps[128]
					if added.ID != "ffffffff" || added.Title != "New <&> 中文" || added.Description != "" || added.Status != core.TaskStepTodo || added.CreatedAt.IsZero() || added.CreatedAt != added.UpdatedAt || added.CreatedAt.Nanosecond()%1000 != 0 {
						t.Fatal("capacity Add target receipt fields/times are not exact")
					}
					taskStepsAddProducerTarget(t, process, requestID, "ffffffff")
					measured = wireBytes
				case code == 1 && status == 409 && stdoutBytes == 0 && strings.Contains(diagnostic, "code=steps_limit_exceeded") && !strings.Contains(strings.ToLower(diagnostic), "outcome is unknown"):
					measured = taskStepsAddCapacityDetail(t, diagnostic, "encodedBytes")
					if measured <= tasksteps.MaxEncodedBytes || taskStepsAddCapacityDetail(t, diagnostic, "maxEncodedBytes") != tasksteps.MaxEncodedBytes || before != snapshot() {
						t.Fatal("known capacity refusal details/state invalid")
					}
				default:
					t.Fatalf("unconfirmed capacity outcome cannot calibrate: exit=%d HTTP=%d stdout=%d diagnostic_bytes=%d", code, status, stdoutBytes, len(diagnostic))
				}
				history = append(history, fmt.Sprintf("target=%d padding=%d HTTP=%d measured=%d", target, padding, status, measured))
				if measured == target {
					digest := ""
					if code == 0 {
						if _, err := file.Seek(0, io.SeekStart); err != nil {
							t.Fatal(err)
						}
						hash := sha256.New()
						if count, err := io.Copy(hash, file); err != nil || count != stdoutBytes {
							t.Fatal("cannot hash complete capacity output")
						}
						digest = fmt.Sprintf("%x", hash.Sum(nil))
						t.Logf("Add producer=%d CLIJSON=%d sha256=%s originalRequest=%s", wireBytes, stdoutBytes, digest, requestID)
					}
					return resource, digest
				}
				padding += int(target - measured)
			}
			t.Fatalf("Add capacity calibration exhausted: %s", strings.Join(history, "; "))
			return api.StepsResource{}, ""
		}
		exact, digest := calibrate(tasksteps.MaxEncodedBytes)
		if digest == "" {
			t.Fatal("exact capacity Add did not return a confirmed full receipt")
		}
		// Read through the installed client again: the service and CLI may encode
		// Unicode differently, while the complete resource values must agree.
		code, file, _, diagnostic := taskStepsAddStressRun(t, cli, "task", "step", "list", task.ID, "--project", project.ID, "--json")
		var current api.StepsResource
		decoder := json.NewDecoder(file)
		if code != 0 || diagnostic != "" || decoder.Decode(&current) != nil {
			t.Fatal("maximum committed Add resource is not readable")
		}
		if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
			t.Fatal("maximum read contains trailing data")
		}
		if current.ProjectID != exact.ProjectID || current.TaskID != exact.TaskID || current.Version != exact.Version || len(current.Steps) != len(exact.Steps) {
			t.Fatal("maximum read lost complete Add facts")
		}
		for index := range exact.Steps {
			if current.Steps[index] != exact.Steps[index] {
				t.Fatal("maximum read differs from confirmed Add resource")
			}
		}
		padding++
		calibrate(tasksteps.MaxEncodedBytes + 1)
		process.signal(t)
		process.stopped(t, 0)
	})
}
