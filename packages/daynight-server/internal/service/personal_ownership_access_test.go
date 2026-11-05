package service

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
)

func TestInheritedOnlyOwnerUsesEveryProjectResourceFamily(t *testing.T) {
	f := newMembershipFixture(t)
	owner := f.user(t)
	project := f.project(t, owner, "  Personal inherited resources  ")
	ctx := context.Background()
	grant := f.member(t, owner, project.ID).Grant
	if err := f.memberships.Remove(ctx, owner, project.ID, owner.UserID, RemoveProjectMember{Version: grant.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal("last direct administrator could not remove its grant", err)
	}
	access, err := f.projects.Access(ctx, owner, project.ID)
	if err != nil || access.Role != model.ProjectAdmin || access.DirectGrant != nil {
		t.Fatalf("Personal owner did not retain independent inherited access: %#v %v", access, err)
	}
	actual, err := f.projects.Get(ctx, owner, project.ID)
	if err != nil || actual != project {
		t.Fatalf("inherited project read changed its raw data: %#v %v", actual, err)
	}
	page, err := f.projects.List(ctx, owner, model.PageRequest{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0] != project || page.NextCursor != nil {
		t.Fatalf("inherited project pagination: %#v %v", page, err)
	}
	if _, err := f.projects.UpdateSettings(ctx, owner, project.ID, UpdateProjectSettings{Version: project.Settings.Version, ExecutionWarningMinutes: 45}); err != nil {
		t.Fatal("inherited administrator could not edit project settings", err)
	}
	participants, err := f.memberships.List(ctx, owner, project.ID)
	if err != nil || len(participants) != 1 || participants[0].UserID != owner.UserID || participants[0].EffectiveRole != model.ProjectAdmin || participants[0].DirectGrant != nil {
		t.Fatalf("inherited participant was omitted or given a synthetic grant: %#v %v", participants, err)
	}

	tasks := NewTasks(f.database)
	task, err := tasks.Create(ctx, owner, project.ID, CreateTask{Title: "Inherited task", AssignedTo: &owner.UserID})
	if err != nil {
		t.Fatal("inherited owner could not create or assign a task", err)
	}
	task, err = tasks.Update(ctx, owner, project.ID, task.ID, UpdateTask{Version: task.Version, Description: pointer("Owned through the Personal Team")})
	if err != nil {
		t.Fatal(err)
	}
	task, err = tasks.SetProperty(ctx, owner, project.ID, task.ID, "pullRequests", `[{"url":"preserved","title":"Evidence"}]`, task.Version)
	if err != nil {
		t.Fatal(err)
	}
	if read, err := tasks.Get(ctx, owner, project.ID, task.ID); err != nil || read.Version != task.Version {
		t.Fatalf("inherited task read: %#v %v", read, err)
	}
	if page, err := tasks.List(ctx, owner, project.ID, TaskListRequest{PageRequest: model.PageRequest{Limit: 10}}); err != nil || len(page.Items) != 1 || page.Items[0].ID != task.ID {
		t.Fatalf("inherited task list: %#v %v", page, err)
	}
	if _, err := tasks.Graph(ctx, owner, project.ID, task.ID); err != nil {
		t.Fatal("inherited graph access", err)
	}
	sync, err := NewTaskSync(f.database, 10*time.Second).Get(ctx, owner, project.ID, TaskSyncRequest{})
	if err != nil || sync.ActorAccess.Role != model.ProjectAdmin || sync.ActorAccess.DirectGrant != nil || len(sync.Tasks) != 1 {
		t.Fatalf("sync did not publish actual inherited access: %#v %v", sync, err)
	}
	assignees, err := tasks.Assignees(ctx, owner, project.ID, TaskAssigneesRequest{UserIDs: []string{owner.UserID}})
	if err != nil || len(assignees.Items) != 1 || !assignees.Items[0].HasProjectAccess || len(assignees.UnresolvedUserIDs) != 0 {
		t.Fatalf("inherited assignee qualification: %#v %v", assignees, err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	attachments := NewAttachments(f.database, files)
	putAttachment(t, attachments, owner, task, "inherited.txt", "Inherited attachment")
	if page, err := attachments.List(ctx, owner, project.ID, task.ID, model.PageRequest{Limit: 10}); err != nil || len(page.Items) != 1 {
		t.Fatalf("inherited attachment metadata: %#v %v", page, err)
	}
	_, object, err := attachments.Open(ctx, owner, project.ID, task.ID, "inherited.txt")
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "Inherited attachment" {
		t.Fatalf("inherited attachment bytes: %q %v %v", content, readErr, closeErr)
	}
	if err := attachments.Delete(ctx, owner, project.ID, task.ID, "inherited.txt"); err != nil {
		t.Fatal(err)
	}
	threads := NewTaskThreads(f.database)
	message := postThread(t, threads, owner, task, CreateThreadMessage{Body: "Inherited discussion"})
	if page := listThread(t, threads, owner, task, ThreadListRequest{}); len(page.Page.Items) != 1 || page.Page.Items[0].ID != message.Message.ID {
		t.Fatal("inherited Thread access returned different messages")
	}

	descriptor := workerDescriptor()
	claimed := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	workers := NewWorkers(f.database)
	report := serviceWorkerReport()
	report.TaskInventory = &model.WorkerTaskInventory{ObservedAt: time.Now().UTC(), Claims: []model.WorkerTaskReference{{ProjectID: project.ID, TaskID: claimed.ID, ClaimID: descriptor.ClaimID}}}
	if _, err := workers.Report(ctx, owner, descriptor.WorkerID, report); err != nil {
		t.Fatal("inherited worker task inventory admission", err)
	}
	detail, err := workers.Get(ctx, owner, descriptor.WorkerID)
	if err != nil || len(detail.Worker.TaskSnapshot.Items) != 1 || detail.Worker.TaskSnapshot.Items[0].TaskID != claimed.ID {
		t.Fatalf("inherited worker task visibility: %#v %v", detail, err)
	}
	external := workerMember(t, f.database, project.ID)
	externalDescriptor := workerDescriptor()
	externalTask := claimWorkerTask(t, tasks, external, claimableTask(t, tasks, external, project.ID), externalDescriptor)
	if _, err := tasks.WithdrawWorker(ctx, owner, project.ID, externalTask.ID, WithdrawWorker{Version: externalTask.Version, ClaimID: externalDescriptor.ClaimID}); err != nil {
		t.Fatal("inherited administrator could not withdraw another worker", err)
	}
	if err := tasks.Delete(ctx, owner, project.ID, task.ID, DeleteTask{Version: task.Version}); err != nil {
		t.Fatal("inherited task deletion", err)
	}
	var grants int
	if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, owner.UserID).Scan(&grants); err != nil || grants != 0 {
		t.Fatalf("resource access recreated a removed grant: %d %v", grants, err)
	}
}

func TestOrdinaryTaskAdmissionDoesNotHoldThreadSourceFences(t *testing.T) {
	tasks, database, project, _, owner := taskService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := database.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, owner.UserID); err != nil {
		t.Fatal(err)
	}
	task := createTask(t, tasks, owner, project.ID, "Ordinary Task locking")
	blocker, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	var id string
	if err := blocker.QueryRow(ctx, `SELECT id::text FROM tasks WHERE id=$1 FOR UPDATE`, task.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	result := make(chan taskResult, 1)
	go func() {
		changed, err := tasks.Update(ctx, owner, project.ID, task.ID, UpdateTask{Version: task.Version, Title: pointer("Admitted task write")})
		result <- taskResult{task: changed, err: err}
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker.Conn().PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case early := <-result:
			t.Fatalf("Task writer did not wait for the real Task lock: %#v %v", early.task, early.err)
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	sources, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer sources.Rollback(context.Background())
	var teamID string
	if err := sources.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR UPDATE NOWAIT`, project.ID).Scan(&teamID); err != nil {
		t.Fatal("ordinary Task admission retained an ownership share lock while waiting for Task", err)
	}
	if err := sources.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR UPDATE NOWAIT`, teamID, owner.UserID).Scan(&id); err != nil {
		t.Fatal("ordinary Task admission retained a Team member share lock while waiting for Task", err)
	}
	if err := sources.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	changed := receiveTaskResult(t, ctx, result)
	if changed.err != nil || changed.task.Title != "Admitted task write" || changed.task.Version != task.Version+1 {
		t.Fatalf("ordinary admitted Task write: %#v %v", changed.task, changed.err)
	}
}
