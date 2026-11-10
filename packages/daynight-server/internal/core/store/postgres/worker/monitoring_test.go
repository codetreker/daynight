package worker_test

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestMonitoringReaderResourceAdmissionAndCurrentSources(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	reader := worker.NewReader(tx).(store.WorkerMonitoringReader)
	user, other := uuid.NewString(), uuid.NewString()
	stamp := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	w := worker.NewWriter(tx)
	within, boundary, expired, foreign := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, record := range []struct {
		user, id string
		last     time.Time
	}{
		{user, within, stamp}, {user, boundary, stamp.Add(-72 * time.Hour)},
		{user, expired, stamp.Add(-72*time.Hour - time.Microsecond)}, {other, foreign, stamp},
	} {
		if _, err := w.UpsertWorker(ctx, snapshot(record.user, record.id, record.last)); err != nil {
			t.Fatal(err)
		}
	}
	got, err := reader.MonitoringWorkers(ctx, user, []string{within, expired, foreign, boundary, uuid.NewString()}, stamp)
	if err != nil || len(got) != 2 {
		t.Fatalf("admitted workers: %v, %v", got, err)
	}
	set := map[string]bool{}
	for _, id := range got {
		set[id] = true
	}
	if !set[within] || !set[boundary] {
		t.Fatalf("admission boundary or owner incorrect: %v", got)
	}
	project, private, deletedProject, teamProject, team := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	task, unclaimed, deletedTask, privateTask, teamTask := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES ($1,'Current Project','host:a'),($2,'Private','host:b'),($3,'Deleted','host:c'),($4,'Team Project','host:d')`, project, private, deletedProject, teamProject)
	execute(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES ($1,$3,'member'),($2,$3,'admin')`, project, deletedProject, user)
	execute(t, tx, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,'Member',statement_timestamp(),statement_timestamp())`, user, user)
	execute(t, tx, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	execute(t, tx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, user)
	execute(t, tx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, teamProject, team)
	execute(t, tx, `INSERT INTO tasks(id,project_id,title,status) VALUES ($1,$6,'Current Title','in_progress'),($2,$6,'Unclaimed','done'),($3,$6,'Deleted','done'),($4,$7,'Private','todo'),($5,$8,'Team Task','todo')`, task, unclaimed, deletedTask, privateTask, teamTask, project, private, teamProject)
	execute(t, tx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{"state":"active"}')`, task)
	execute(t, tx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, deletedTask)
	execute(t, tx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, deletedProject)
	projectIDs := []string{project, private, deletedProject, teamProject}
	taskIDs := []string{task, unclaimed, deletedTask, privateTask, teamTask}
	sources, err := reader.MonitoringSources(ctx, user, projectIDs, taskIDs)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sources.Projects, map[string]string{project: "Current Project", teamProject: "Team Project"}) || len(sources.Tasks) != 3 {
		t.Fatalf("visible sources: %+v", sources)
	}
	claimed := sources.Tasks[task]
	if claimed.Task.ProjectID != project || claimed.Task.Title != "Current Title" || claimed.ProjectName != "Current Project" || string(claimed.Task.Properties["worker"]) != `{"state":"active"}` {
		t.Fatalf("claimed source: %+v", claimed)
	}
	if sources.Tasks[unclaimed].Task.Properties != nil || sources.Tasks[teamTask].ProjectName != "Team Project" {
		t.Fatalf("unclaimed/team sources: %+v", sources.Tasks)
	}
	execute(t, tx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project, user)
	execute(t, tx, `UPDATE projects SET name='Renamed' WHERE id=$1`, teamProject)
	sources, err = reader.MonitoringSources(ctx, user, projectIDs, taskIDs)
	if err != nil || !reflect.DeepEqual(sources.Projects, map[string]string{teamProject: "Renamed"}) || len(sources.Tasks) != 1 || sources.Tasks[teamTask].ProjectName != "Renamed" {
		t.Fatalf("revoked or renamed sources: %+v %v", sources, err)
	}
}

func TestMonitoringReaderEmptyAndClosedTransaction(t *testing.T) {
	tx := workerTransaction(t)
	ctx := t.Context()
	reader := worker.NewReader(tx).(store.WorkerMonitoringReader)
	id := uuid.NewString()
	ids, err := reader.MonitoringWorkers(ctx, id, nil, time.Now())
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("empty workers: %v %v", ids, err)
	}
	sources, err := reader.MonitoringSources(ctx, id, nil, nil)
	if err != nil || sources.Projects == nil || sources.Tasks == nil {
		t.Fatalf("empty sources: %+v %v", sources, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.MonitoringWorkers(ctx, id, []string{id}, time.Now()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("worker cause lost: %v", err)
	}
	if _, err := reader.MonitoringSources(ctx, id, []string{id}, nil); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("project cause lost: %v", err)
	}
	if _, err := reader.MonitoringSources(ctx, id, nil, []string{id}); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("task cause lost: %v", err)
	}
}
