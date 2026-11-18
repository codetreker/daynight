package usage_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestUsageDeletedGoalHidesRetainedChildAndResetsChainMembership(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	root := testutil.QueryTask(t, f.db, f.project, 401, model.TaskTodo)
	goal := uuid.NewString()
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,type,title,description,status) VALUES($1,$2,'goal','Deleted parent','','todo')`, goal, f.project)
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, f.task)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,title,description,status) SELECT gen_random_uuid(),$1,'Visible member','','todo' FROM generate_series(1,99)`, f.project)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) SELECT project_id,$2,id FROM tasks WHERE project_id=$1 AND type='task' AND id<>$2`, f.project, root.ID)
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "7"))); err != nil {
		t.Fatal(err)
	}
	before, err := f.service.Aggregate(ctx, f.actor, f.project, "chain", root.ID, "")
	if err != nil || before.Members.Total != "101" || before.NextMembersCursor == nil || core.Value(before.Summary.Metrics["outputTokens"].Known) != "7" {
		t.Fatal(before, err)
	}
	childRoot, err := f.service.Aggregate(ctx, f.actor, f.project, "chain", f.task, "")
	if err != nil || childRoot.Members.Total != "101" {
		t.Fatal(childRoot, err)
	}
	group, err := f.service.Aggregate(ctx, f.actor, f.project, "goal", goal, "")
	if err != nil || group.Members.Total != "1" {
		t.Fatal(group, err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, goal)
	var retained, hidden bool
	if err = f.db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL,effective_deleted_at IS NOT NULL FROM task_resource_rows WHERE id=$1`, f.task).Scan(&retained, &hidden); err != nil || !retained || !hidden {
		t.Fatal(retained, hidden, err)
	}
	_, err = f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task})
	requireCode(t, err, "resource_unavailable")
	_, err = f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "measurement", Limit: 100})
	requireCode(t, err, "resource_unavailable")
	_, err = f.service.State(ctx, f.actor, reg.State.ID)
	requireCode(t, err, "resource_unavailable")
	for _, scope := range [][2]string{{"chain", f.task}, {"goal", goal}} {
		_, err = f.service.Aggregate(ctx, f.actor, f.project, scope[0], scope[1], "")
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatal(scope, err)
		}
	}
	after, err := f.service.Aggregate(ctx, f.actor, f.project, "chain", root.ID, "")
	if err != nil || after.Members.Total != "100" || after.MembershipRevision == before.MembershipRevision || after.Summary.Metrics["outputTokens"].Known != nil {
		t.Fatal(after, err)
	}
	for _, member := range after.MissingMembers {
		if member.TaskID == f.task {
			t.Fatal("hidden child leaked through member page")
		}
	}
	_, err = f.service.Aggregate(ctx, f.actor, f.project, "chain", root.ID, *before.NextMembersCursor)
	requireCode(t, err, "reset_required")
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1")))
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("hidden child admitted write", err)
	}
}
