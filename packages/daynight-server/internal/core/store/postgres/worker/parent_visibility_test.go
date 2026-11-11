package worker_test

import (
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
)

func TestWorkerReadsHideChildrenOfDeletedGoal(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	writer := worker.NewWriter(tx)
	reader := worker.NewReader(tx)
	monitor := reader.(store.WorkerMonitoringReader)
	user, workerID, project, goal, hidden, visible := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','host:repo')`, project)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project, user)
	execute(t, tx, `INSERT INTO tasks(id,project_id,title,type,status) VALUES($1,$4,'Goal','goal','todo'),($2,$4,'Hidden','task','in_progress'),($3,$4,'Visible','task','in_progress')`, goal, hidden, visible, project)
	execute(t, tx, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, hidden)
	execute(t, tx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{}'),($2,'worker','{}')`, hidden, visible)
	stamp := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	observed := snapshot(user, workerID, stamp)
	observed.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &stamp, InventoryObservedAt: &stamp, Items: []model.WorkerObservedTask{
		{ProjectID: project, TaskID: hidden, ClaimID: uuid.NewString(), Title: "Hidden", Status: model.TaskInProgress},
		{ProjectID: project, TaskID: visible, ClaimID: uuid.NewString(), Title: "Visible", Status: model.TaskInProgress},
	}}
	if _, err := writer.UpsertWorker(ctx, observed); err != nil {
		t.Fatal(err)
	}
	inventory := model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{
		{ProjectID: project, TaskID: hidden, ClaimID: observed.TaskSnapshot.Items[0].ClaimID},
		{ProjectID: project, TaskID: visible, ClaimID: observed.TaskSnapshot.Items[1].ClaimID},
	}}
	check := func(want int) {
		t.Helper()
		sources, err := writer.ReportTaskSnapshots(ctx, user, inventory)
		if err != nil || len(sources) != want {
			t.Fatalf("report sources=%+v error=%v", sources, err)
		}
		detail, err := reader.Worker(ctx, user, workerID, stamp)
		if err != nil || len(detail.TaskSnapshot.Items) != want {
			t.Fatalf("detail=%+v error=%v", detail.TaskSnapshot, err)
		}
		list, err := reader.Workers(ctx, user, stamp, store.Page{Limit: 10})
		if err != nil || len(list.Items) != 1 || !reflect.DeepEqual(list.Items[0].TaskSnapshot, detail.TaskSnapshot) {
			t.Fatalf("list=%+v error=%v", list, err)
		}
		summaries, err := reader.WorkerSummaries(ctx, user, stamp, store.Page{Limit: 10})
		if err != nil || len(summaries.Items) != 1 || summaries.Items[0].ActiveTaskCount == nil || *summaries.Items[0].ActiveTaskCount != want {
			t.Fatalf("summaries=%+v error=%v", summaries, err)
		}
		monitoring, err := monitor.MonitoringSources(ctx, user, []string{project}, []string{hidden, visible})
		if err != nil || len(monitoring.Tasks) != want {
			t.Fatalf("monitoring=%+v error=%v", monitoring, err)
		}
		if want == 1 {
			if sources[0].Task.ID != visible || detail.TaskSnapshot.Items[0].TaskID != visible || monitoring.Tasks[visible].Task.ID != visible {
				t.Fatalf("wrong task survived: sources=%+v detail=%+v monitoring=%+v", sources, detail.TaskSnapshot, monitoring)
			}
		}
	}
	check(2)
	execute(t, tx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, goal)
	check(1)
	execute(t, tx, `UPDATE tasks SET deleted_at=NULL WHERE id=$1`, goal)
	check(2)
	saved, err := reader.Worker(ctx, user, workerID, stamp)
	if err != nil || !reflect.DeepEqual(saved.TaskSnapshot, observed.TaskSnapshot) {
		t.Fatalf("filter changed saved observation: %+v error=%v", saved.TaskSnapshot, err)
	}
}
