package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
)

func TestStoredPropertyMissingAndDuplicateFieldsDoNotBecomeEmptyValues(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 2, model.TaskTodo)
	ctx := context.Background()
	for _, test := range []struct{ name, raw string }{
		{"missing title", `[{"url":"private-property-url"}]`},
		{"duplicate url field", `[{"url":"private-property-url","url":"private-property-url","title":"Title"}]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			putTaskPropertyFixture(t, database, target.ID, "pullRequests", []byte(test.raw))
			before := taskPropertyFacts(t, database)
			for _, read := range []struct {
				name string
				call func(store.SnapshotScope) error
			}{
				{"single task", func(scope store.SnapshotScope) error {
					_, err := scope.TaskDAO().Task(ctx, project.ID, target.ID)
					return err
				}},
				{"task page", func(scope store.SnapshotScope) error {
					_, err := scope.TaskDAO().Tasks(ctx, project.ID, store.TaskQuery{Page: store.Page{Limit: 10}})
					return err
				}},
			} {
				t.Run(read.name, func(t *testing.T) {
					err := database.ReadSnapshot(ctx, read.call)
					var invalid *taskproperty.ValidationError
					if !errors.As(err, &invalid) || strings.Contains(err.Error(), "private-property-url") {
						t.Fatalf("invalid stored fields lost validation category or leaked their value: %v", err)
					}
				})
			}
			completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
				_, err := scope.TaskDAO().Task(ctx, target.ID)
				return err
			})
			var invalid *taskproperty.ValidationError
			if !errors.As(err, &invalid) || completion.Outcome != store.TransactionNotCommitted ||
				!reflect.DeepEqual(taskPropertyFacts(t, database), before) {
				t.Fatalf("invalid scoped read committed or changed stored facts: completion=%#v err=%v", completion, err)
			}
			if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
				items, err := scope.TaskDAO().TaskGraphTasks(ctx, project.ID, target.ID, testGraphSelection(), 160)
				if err != nil {
					return err
				}
				if len(items) != 1 || items[0].ID != target.ID || items[0].TitlePreview != target.Title {
					t.Fatalf("graph projection depended on full properties: %#v", items)
				}
				return nil
			}); err != nil {
				t.Fatalf("corrupt full properties prevented bounded graph projection: %v", err)
			}
		})
	}
}

func TestBoundedTaskPropertyReadsNormalizeHistoricalTextBeforeBudgeting(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 2, model.TaskTodo)
	ctx := context.Background()
	raw := strings.Repeat(" \n", 300000) + `[{"url":"` + strings.Repeat(`\u0061`, 100000) + `","title":""}]`
	putTaskPropertyFixture(t, database, target.ID, "pullRequests", []byte(raw))
	before := taskPropertyFacts(t, database)
	var actual model.Task
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		actual, err = scope.TaskDAO().(*taskdao.Reader).TaskBounded(ctx, project.ID, target.ID, false)
		return err
	}); err != nil {
		t.Fatalf("raw historical text was charged before normalization: %v", err)
	}
	want := `[{"url":"` + strings.Repeat("a", 100000) + `","title":""}]`
	if len(raw) <= 512<<10 || len(want) >= 512<<10 || string(actual.Properties["pullRequests"]) != want {
		t.Fatalf("bounded property normalization changed: raw=%d normalized=%d got=%d", len(raw), len(want), len(actual.Properties["pullRequests"]))
	}
	metadata := actual
	metadata.Properties = target.Properties
	if !reflect.DeepEqual(metadata, target) || !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
		t.Fatal("bounded property read changed Task metadata or persisted normalized text")
	}
	oversized := `[{"url":"` + strings.Repeat("x", 600000) + `","title":""}]`
	putTaskPropertyFixture(t, database, target.ID, "pullRequests", []byte(oversized))
	before = taskPropertyFacts(t, database)
	actual = model.Task{}
	err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		actual, err = scope.TaskDAO().(*taskdao.Reader).TaskBounded(ctx, project.ID, target.ID, false)
		return err
	})
	var fault *model.Fault
	if !json.Valid([]byte(oversized)) || !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" ||
		!reflect.DeepEqual(actual, model.Task{}) || !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
		t.Fatalf("oversized normalized property escaped bounded read or changed storage: task=%#v err=%v", actual, err)
	}
}

func TestBoundedTaskPageReportsActualPropertyOverflowAfterValidPrefix(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	first := queryTask(t, database, project.ID, 2, model.TaskTodo)
	second := queryTask(t, database, project.ID, 3, model.TaskTodo)
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	mustQueryExec(t, database, `UPDATE tasks SET created_at=$2 WHERE id=$1`, first.ID, stamp)
	mustQueryExec(t, database, `UPDATE tasks SET created_at=$2 WHERE id=$1`, second.ID, stamp.Add(time.Second))
	putTaskPropertyFixture(t, database, second.ID, "pullRequests", []byte(`[{"url":"`+strings.Repeat("x", 4<<20)+`","title":""}]`))
	before := taskPropertyFacts(t, database)
	ctx := context.Background()
	var prefix, overflow store.TaskPage
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		query := store.TaskQuery{Page: store.Page{Limit: 1}, BoundedText: true}
		var err error
		prefix, err = scope.TaskDAO().Tasks(ctx, project.ID, query)
		if err != nil {
			return err
		}
		if len(prefix.Items) != 1 || prefix.Items[0].ID != first.ID || prefix.Oversized || !prefix.HasMore {
			t.Fatalf("normal prefix was lost before property lookahead: %#v", prefix)
		}
		query.Page.After = &store.Position{ID: prefix.Items[0].ID, CreatedAt: prefix.Items[0].CreatedAt}
		overflow, err = scope.TaskDAO().Tasks(ctx, project.ID, query)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if len(overflow.Items) != 1 || overflow.Items[0].ID != second.ID || !overflow.Oversized || overflow.HasMore ||
		len(overflow.Items[0].Properties) != 0 || prefix.Items[0].ID != first.ID || prefix.Oversized ||
		!reflect.DeepEqual(taskPropertyFacts(t, database), before) {
		t.Fatalf("bounded property overflow lost candidate identity, valid prefix or storage: prefix=%#v overflow=%#v", prefix, overflow)
	}
}

func TestBoundedLegacyTaskReadsCompactOversizedIncompatibleWorker(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 2, model.TaskTodo)
	worker := &model.WorkerClaim{
		ClaimID: queryID(3), State: model.WorkerActive, UserID: queryID(4), WorkerID: queryID(5),
		Machine:  model.WorkerMachine{ID: queryID(6), Name: strings.Repeat("w", 600000)},
		Platform: model.PlatformLinux, Agent: model.AgentClaude, AgentControlMode: model.AgentControlModeWeb,
		WorktreeID: queryID(7), Phase: model.WorkerExecuting, ClaimedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	raw, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		t.Fatal(err)
	}
	putTaskPropertyFixture(t, database, target.ID, "worker", raw)
	before := taskPropertyFacts(t, database)
	ctx := context.Background()
	for _, pageRead := range []bool{false, true} {
		t.Run(map[bool]string{false: "single task", true: "task page"}[pageRead], func(t *testing.T) {
			var actual model.Task
			if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
				if !pageRead {
					var err error
					actual, err = scope.TaskDAO().(*taskdao.Reader).TaskBounded(ctx, project.ID, target.ID, true)
					return err
				}
				page, err := scope.TaskDAO().Tasks(ctx, project.ID, store.TaskQuery{Page: store.Page{Limit: 1}, BoundedText: true, LegacyProjection: true})
				if err != nil {
					return err
				}
				if len(page.Items) != 1 || page.Items[0].ID != target.ID || page.Oversized || page.HasMore {
					t.Fatalf("legacy bounded page lost incompatible-worker Task: %#v", page)
				}
				actual = page.Items[0]
				return nil
			}); err != nil {
				t.Fatalf("legacy read materialized oversized incompatible Worker: %v", err)
			}
			got, err := taskproperty.Worker(actual.Properties)
			want := *worker
			want.Machine.Name = "worker"
			if err != nil || got == nil || !reflect.DeepEqual(*got, want) || len(raw) <= 512<<10 || len(actual.Properties["worker"]) >= 512<<10 {
				t.Fatalf("legacy stored Worker summary lost identity or remained oversized: %#v %v", got, err)
			}
			metadata := actual
			metadata.Properties = target.Properties
			if !reflect.DeepEqual(metadata, target) || !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
				t.Fatal("legacy bounded read changed Task metadata or raw Worker property")
			}
		})
	}
	var extended model.Task
	err = database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		extended, err = scope.TaskDAO().(*taskdao.Reader).TaskBounded(ctx, project.ID, target.ID, false)
		return err
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" || !reflect.DeepEqual(extended, model.Task{}) ||
		!reflect.DeepEqual(taskPropertyFacts(t, database), before) {
		t.Fatalf("extended read omitted incompatible Worker or changed storage: task=%#v err=%v", extended, err)
	}
}
