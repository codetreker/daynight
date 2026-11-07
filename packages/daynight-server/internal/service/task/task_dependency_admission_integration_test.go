package task_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func TestTaskDependencyAdmissionAndAtomicityPostgres(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	prerequisites := make([]model.Task, 16)
	ids := make([]string, len(prerequisites))
	for i := range prerequisites {
		prerequisites[i] = createTask(t, tasks, principal, project.ID, fmt.Sprintf("Prerequisite %d", i))
		ids[i] = prerequisites[i].ID
	}
	firstFifteen := slices.Clone(ids[:15])
	target, err := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "Target", DependsOn: firstFifteen, ExternalDependsOn: firstFifteen[:2]})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(firstFifteen)
	if !slices.Equal(target.DependsOn, firstFifteen) || len(target.ExternalDependsOn) != 2 || target.Ready {
		t.Fatalf("15 dependencies were not persisted: %+v", target)
	}
	var beforeEdges []string
	readEdges := func() []string {
		t.Helper()
		var ids []string
		if err := database.Pool.QueryRow(ctx, `SELECT ARRAY(SELECT depends_on_task_id::text FROM task_dependencies WHERE task_id=$1 ORDER BY depends_on_task_id)`, target.ID).Scan(&ids); err != nil {
			t.Fatal(err)
		}
		return ids
	}
	beforeEdges = readEdges()
	if !slices.Equal(beforeEdges, firstFifteen) {
		t.Fatalf("stored edges: %v", beforeEdges)
	}
	var graphQueries, inserts atomic.Int32
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
		if strings.Contains(sql, "t.id = ANY($2::uuid[])") || strings.Contains(sql, "WITH RECURSIVE edges") {
			graphQueries.Add(1)
		}
		if strings.Contains(sql, "INSERT INTO task_dependencies") {
			inserts.Add(1)
		}
		return false
	}})
	if _, err := traced.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "Trace control", DependsOn: ids[:1]}); err != nil {
		t.Fatal(err)
	}
	if graphQueries.Load() < 2 || inserts.Load() == 0 {
		t.Fatalf("trace control did not observe prerequisite, reachability and insert: %d/%d", graphQueries.Load(), inserts.Load())
	}
	graphQueries.Store(0)
	inserts.Store(0)
	_, err = traced.Update(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Must not persist"), DependsOn: &ids})
	requireFault(t, err, "invalid_input")
	if graphQueries.Load() != 0 || inserts.Load() != 0 {
		t.Fatalf("oversized dependency update reached graph/insert: %d/%d", graphQueries.Load(), inserts.Load())
	}
	assertTaskUnchanged(t, tasks, principal, target)
	if afterEdges := readEdges(); !slices.Equal(beforeEdges, afterEdges) {
		t.Fatalf("rejected update changed stored edges: %v", afterEdges)
	}

	otherProject, err := projectservice.NewProjects(database).Create(ctx, principal, projectcore.CreateProject{ExpectedUserID: principal.UserID, Name: "Other", RepoURL: "host:other"})
	if err != nil {
		t.Fatal(err)
	}
	other := createTask(t, tasks, principal, otherProject.ID, "Other")
	for _, dependencies := range [][]string{{ids[0], ids[0]}, {target.ID}, {other.ID}} {
		_, err := tasks.Update(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, DependsOn: &dependencies})
		requireFault(t, err, "invalid_input")
		assertTaskUnchanged(t, tasks, principal, target)
	}
	_, err = tasks.Update(ctx, principal, project.ID, prerequisites[0].ID, taskcore.UpdateTask{Version: prerequisites[0].Version, DependsOn: pointer([]string{target.ID})})
	requireFault(t, err, "dependency_cycle")
	assertTaskUnchanged(t, tasks, principal, prerequisites[0])
	_, err = tasks.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskInProgress})
	requireFault(t, err, "dependency_unsatisfied")
	assertTaskUnchanged(t, tasks, principal, target)
}
