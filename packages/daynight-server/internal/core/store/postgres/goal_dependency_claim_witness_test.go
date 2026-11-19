package postgres

import (
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func TestWorkerClaimWithGoalAndTaskEdges(t *testing.T) {
	db, principal, _, project := membershipFixture(t)
	ctx := t.Context()
	goal, prerequisite := uuid.NewString(), uuid.NewString()
	child, blocked, taskPrerequisite := uuid.NewString(), uuid.NewString(), uuid.NewString()
	edgeID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES
 ($1,$3,'goal','Owner goal','todo'),($2,$3,'goal','Pending prerequisite','todo')`, goal, prerequisite, project.ID)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status,parent_id,assigned_to,allow_agents) VALUES
 ($1,$4,'task','Ready child','todo',$5,$6,true),
 ($2,$4,'task','Blocked child','todo',$5,$6,true),
 ($3,$4,'task','Task prerequisite','todo',$5,$6,false)`, child, blocked, taskPrerequisite, project.ID, goal, principal.UserID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES
 ($1,$2,$3,'goal',$4)`, project.ID, goal, prerequisite, edgeID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, blocked, taskPrerequisite)
	workerID := uuid.NewString()
	testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
	tasks := taskservice.NewTasks(db)
	beforeGoal := snapshotTask(t, db, project.ID, goal)
	if len(beforeGoal.DependsOn) != 0 || len(beforeGoal.BlockedBy) != 0 || beforeGoal.Ready {
		t.Fatalf("ordinary Goal projection exposed its Goal edge: %+v", beforeGoal)
	}
	ready, allowed := true, true
	page, err := tasks.List(ctx, principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}, AutomaticCandidate: true, CandidateWorkerID: &workerID, Ready: &ready, AllowAgents: &allowed, AssignedTo: &principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != child || !page.Items[0].Ready {
		t.Fatalf("mixed edges changed Worker candidates: %+v", page)
	}
	candidate := page.Items[0]
	blockedView := snapshotTask(t, db, project.ID, blocked)
	if blockedView.Ready || !reflect.DeepEqual(blockedView.BlockedBy, []string{taskPrerequisite}) {
		t.Fatalf("ordinary edge did not block candidate: %+v", blockedView)
	}
	descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
	claimed, err := tasks.ClaimWorker(ctx, principal, project.ID, child, taskcore.ClaimWorker{Version: candidate.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	after := snapshotTask(t, db, project.ID, child)
	worker, err := taskproperty.Worker(after.Properties)
	if err != nil || worker == nil || worker.ClaimID != descriptor.ClaimID || worker.WorkerID != descriptor.WorkerID || worker.State != model.WorkerActive || after.Status != model.TaskInProgress || after.Version != candidate.Version+1 || !reflect.DeepEqual(after, claimed) {
		t.Fatalf("claim was not persisted: task=%+v worker=%+v error=%v", after, worker, err)
	}
	afterGoal := snapshotTask(t, db, project.ID, goal)
	if afterGoal.Status != model.TaskInProgress || afterGoal.Version != beforeGoal.Version+1 || afterGoal.StartedAt == nil || len(afterGoal.DependsOn) != 0 {
		t.Fatalf("claim did not start Goal while preserving ordinary projection: before=%+v after=%+v", beforeGoal, afterGoal)
	}
	var goalEdges, taskEdges int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE dependency_type='goal' AND task_id=$2 AND depends_on_task_id=$3 AND goal_edge_id=$6),
 count(*) FILTER(WHERE dependency_type='task' AND task_id=$4 AND depends_on_task_id=$5 AND goal_edge_id IS NULL)
 FROM task_dependencies WHERE project_id=$1`, project.ID, goal, prerequisite, blocked, taskPrerequisite, edgeID).Scan(&goalEdges, &taskEdges); err != nil || goalEdges != 1 || taskEdges != 1 {
		t.Fatalf("claim changed existing edges: goal=%d task=%d error=%v", goalEdges, taskEdges, err)
	}
}
