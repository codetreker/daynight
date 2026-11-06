package pg

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type projectionRow struct {
	values []any
	err    error
}

func (row projectionRow) Scan(destinations ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(destinations) != len(row.values) {
		return errors.New("projection width mismatch")
	}
	for i, value := range row.values {
		reflect.ValueOf(destinations[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type projectionRows struct {
	pgx.Rows
	items  []projectionRow
	index  int
	err    error
	closed bool
}

func (rows *projectionRows) Next() bool {
	rows.index++
	return rows.index <= len(rows.items)
}
func (rows *projectionRows) Scan(destinations ...any) error {
	return rows.items[rows.index-1].Scan(destinations...)
}
func (rows *projectionRows) Close()     { rows.closed = true }
func (rows *projectionRows) Err() error { return rows.err }

func projectionTime() time.Time {
	return time.Date(2026, 11, 6, 11, 20, 0, 0, time.FixedZone("test", 3*60*60))
}

func TestScanProjectRequiresOwnershipAndNormalizesTimes(t *testing.T) {
	at := projectionTime()
	teamID, version := "team-id", int64(7)
	values := []any{"project-id", "project", "https://example.test/repo", at, at, int64(5), int32(20), &teamID, &version, &at}
	project, err := ScanProject(projectionRow{values: values})
	if err != nil {
		t.Fatal(err)
	}
	want := model.Project{ID: "project-id", Name: "project", RepoURL: "https://example.test/repo", CreatedAt: at.UTC(), UpdatedAt: at.UTC(),
		Settings:  model.ProjectSettings{Version: 5, ExecutionWarningMinutes: 20},
		Ownership: model.ProjectOwnership{TeamID: teamID, Version: version, UpdatedAt: at.UTC()}}
	if !reflect.DeepEqual(project, want) {
		t.Fatalf("project = %#v, want %#v", project, want)
	}
	for _, index := range []int{7, 8, 9} {
		t.Run([]string{"team", "version", "ownership time"}[index-7], func(t *testing.T) {
			missing := append([]any(nil), values...)
			missing[index] = reflect.Zero(reflect.TypeOf(values[index])).Interface()
			if result, err := ScanProject(projectionRow{values: missing}); err == nil || !reflect.DeepEqual(result, model.Project{}) {
				t.Fatalf("missing ownership accepted: %#v, %v", result, err)
			}
		})
	}
	cause := errors.New("project scan failed")
	if _, err := ScanProject(projectionRow{err: cause}); !errors.Is(err, cause) {
		t.Fatalf("scan error = %v", err)
	}
}

func taskProjection(at time.Time, status model.TaskStatus) projectionRow {
	platform, assignee := model.TaskPlatform("linux"), "assignee"
	return projectionRow{values: []any{"task", "project", "title", "description", status, int64(9), at, at, &at, &at, true, &platform, &assignee,
		[]string{"dependency"}, []string{"external"}, []string{"blocked"}, true}}
}

func TestScanTaskPreservesProjectionAndRejectsInvalidStatus(t *testing.T) {
	at := projectionTime()
	task, err := ScanTask(taskProjection(at, model.TaskDone))
	if err != nil {
		t.Fatal(err)
	}
	platform, assignee, utc := model.TaskPlatform("linux"), "assignee", at.UTC()
	want := model.Task{ID: "task", ProjectID: "project", Title: "title", Description: "description", Status: model.TaskDone, Version: 9,
		CreatedAt: utc, UpdatedAt: utc, StartedAt: &utc, CompletedAt: &utc, AllowAgents: true, RequiredPlatform: &platform,
		AssignedTo: &assignee, DependsOn: []string{"dependency"}, ExternalDependsOn: []string{"external"}, BlockedBy: []string{"blocked"}, Ready: true,
		Properties: model.TaskProperties{}}
	if !reflect.DeepEqual(task, want) {
		t.Fatalf("task = %#v, want %#v", task, want)
	}
	if _, err := ScanTask(taskProjection(at, "invalid")); err == nil {
		t.Fatal("invalid stored status accepted")
	}
	cause := errors.New("task scan failed")
	if _, err := ScanTask(projectionRow{err: cause}); !errors.Is(err, cause) {
		t.Fatalf("scan error = %v", err)
	}
	row := taskProjection(at, model.TaskTodo)
	row.values = append(row.values, int64(23))
	var trailing int64
	if _, err := ScanTask(row, &trailing); err != nil || trailing != 23 {
		t.Fatalf("trailing projection = %d, %v", trailing, err)
	}
}

func TestCollectTasksClosesRowsAndRetainsReadFailures(t *testing.T) {
	at := projectionTime()
	rows := &projectionRows{items: []projectionRow{taskProjection(at, model.TaskTodo), taskProjection(at, model.TaskDone)}}
	tasks, err := CollectTasks(rows)
	if err != nil || len(tasks) != 2 || tasks[0].Status != model.TaskTodo || tasks[1].Status != model.TaskDone || !rows.closed {
		t.Fatalf("tasks = %#v, error = %v, closed = %v", tasks, err, rows.closed)
	}
	rows = &projectionRows{}
	if tasks, err := CollectTasks(rows); err != nil || tasks == nil || len(tasks) != 0 || !rows.closed {
		t.Fatalf("empty collection = %#v, %v, closed = %v", tasks, err, rows.closed)
	}
	cause := errors.New("read failed")
	rows = &projectionRows{items: []projectionRow{{err: cause}}}
	if tasks, err := CollectTasks(rows); tasks != nil || !errors.Is(err, cause) || !rows.closed {
		t.Fatalf("scan failure = %#v, %v, closed = %v", tasks, err, rows.closed)
	}
	rows = &projectionRows{err: cause}
	if _, err := CollectTasks(rows); !errors.Is(err, cause) || !rows.closed {
		t.Fatalf("iteration failure = %v, closed = %v", err, rows.closed)
	}
}

func TestLiveTaskRowRejectsDeletionAndRetainsScanErrors(t *testing.T) {
	at := projectionTime()
	var title string
	if err := (LiveTaskRow{projectionRow{values: []any{"live", (*time.Time)(nil)}}}).Scan(&title); err != nil || title != "live" {
		t.Fatalf("live task = %q, %v", title, err)
	}
	if err := (LiveTaskRow{projectionRow{values: []any{"deleted", &at}}}).Scan(&title); !errors.Is(err, model.ErrTaskDeleted) {
		t.Fatalf("deleted task error = %v", err)
	}
	cause := errors.New("live row failed")
	if err := (LiveTaskRow{projectionRow{err: cause}}).Scan(&title); !errors.Is(err, cause) {
		t.Fatalf("scan error = %v", err)
	}
}

func TestPageValuesAndUTCTimePreserveAbsence(t *testing.T) {
	if at, id := PageValues(store.Page{}); at != nil || id != nil {
		t.Fatalf("absent position = %v, %v", at, id)
	}
	at := projectionTime()
	if value, id := PageValues(store.Page{After: &store.Position{CreatedAt: at, ID: "cursor"}}); value != at || id != "cursor" {
		t.Fatalf("position = %v, %v", value, id)
	}
	if UTCTime(nil) != nil {
		t.Fatal("absent time was populated")
	}
	if utc := UTCTime(&at); !utc.Equal(at) || utc.Location() != time.UTC || at.Location() == time.UTC {
		t.Fatalf("UTC time = %v; original = %v", utc, at)
	}
}

func TestScanTaskStepMapsEveryField(t *testing.T) {
	at := projectionTime()
	step, err := ScanTaskStep(projectionRow{values: []any{"step", int64(4), "title", "description", model.TaskStepSkipped, at, at}})
	want := model.TaskStep{ID: "step", Position: 4, Title: "title", Description: "description", Status: model.TaskStepSkipped, CreatedAt: at.UTC(), UpdatedAt: at.UTC()}
	if err != nil || !reflect.DeepEqual(step, want) {
		t.Fatalf("step = %#v, %v; want %#v", step, err, want)
	}
	cause := errors.New("step scan failed")
	if _, err := ScanTaskStep(projectionRow{err: cause}); !errors.Is(err, cause) {
		t.Fatalf("scan error = %v", err)
	}
}

func TestScanThreadMessageRequiresCompleteExecutionAttribution(t *testing.T) {
	at := projectionTime()
	name, claim, worker, provider, reply := "author", "claim", "worker", "codex", "reply"
	for _, execution := range []struct {
		name                    string
		claim, worker, provider *string
	}{
		{"complete", &claim, &worker, &provider},
		{"human", nil, nil, nil},
		{"missing claim", nil, &worker, &provider},
		{"missing worker", &claim, nil, &provider},
		{"missing provider", &claim, &worker, nil},
	} {
		t.Run(execution.name, func(t *testing.T) {
			message, err := ScanThreadMessage(projectionRow{values: []any{"task", "message", at, "user", &name, true, execution.claim, execution.worker, execution.provider, "body", &reply}})
			want := model.ThreadMessage{TaskID: "task", ID: "message", CreatedAt: at.UTC(), Body: "body", ReplyTo: &reply,
				Author: model.ThreadAuthor{UserID: "user", DisplayName: &name, Agent: true}}
			if execution.name == "complete" {
				want.Author.Execution = &model.ThreadExecution{ClaimID: claim, WorkerID: worker, Provider: provider}
			}
			if err != nil || !reflect.DeepEqual(message, want) {
				t.Fatalf("message = %#v, %v; want %#v", message, err, want)
			}
		})
	}
	cause := errors.New("thread scan failed")
	if _, err := ScanThreadMessage(projectionRow{err: cause}); !errors.Is(err, cause) {
		t.Fatalf("scan error = %v", err)
	}
}

func TestScanWorkerSnapshotDecodesPayloadsAndNormalizesTimes(t *testing.T) {
	at := projectionTime()
	telemetry := []byte(`{"workingDirectory":"/workspace","platform":"linux"}`)
	tasks := []byte(`{"state":"observed","observedAt":"2026-11-06T11:20:00+03:00","inventoryObservedAt":"2026-11-06T11:20:00+03:00","items":[{"taskId":"task"}]}`)
	worker, err := ScanWorkerSnapshot(projectionRow{values: []any{"user", "worker", at, at, telemetry, tasks}})
	utc := at.UTC()
	want := model.WorkerSnapshot{UserID: "user", WorkerID: "worker", CreatedAt: utc, LastReportedAt: utc,
		Telemetry:    model.WorkerTelemetry{WorkingDirectory: "/workspace", Platform: "linux"},
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &utc, InventoryObservedAt: &utc, Items: []model.WorkerObservedTask{{TaskID: "task"}}}}
	if err != nil || !reflect.DeepEqual(worker, want) {
		t.Fatalf("worker = %#v, %v; want %#v", worker, err, want)
	}
	for _, payloads := range [][2][]byte{{[]byte(`{`), tasks}, {telemetry, []byte(`{`)}} {
		if result, err := ScanWorkerSnapshot(projectionRow{values: []any{"user", "worker", at, at, payloads[0], payloads[1]}}); err == nil || !reflect.DeepEqual(result, model.WorkerSnapshot{}) {
			t.Fatalf("malformed payload accepted: %#v, %v", result, err)
		}
	}
	cause := errors.New("worker scan failed")
	if _, err := ScanWorkerSnapshot(projectionRow{err: cause}); !errors.Is(err, cause) {
		t.Fatalf("scan error = %v", err)
	}
}

func TestAuthQueryErrorRetainsMissingCredential(t *testing.T) {
	err := AuthQueryError("read credential", pgx.ErrNoRows)
	var failure *store.Error
	if !errors.As(err, &failure) || failure.Phase != "read credential" || !errors.Is(err, pgx.ErrNoRows) || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("authentication query failure = %v", err)
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		t.Fatalf("missing credential marked as database failure: %v", err)
	}
}
