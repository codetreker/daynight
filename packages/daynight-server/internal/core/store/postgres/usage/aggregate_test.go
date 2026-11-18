package usage_test

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestUsageChainAndGoalMembershipIsolation(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	b := testutil.QueryTask(t, f.db, f.project, 401, model.TaskCancelled)
	c := testutil.QueryTask(t, f.db, f.project, 402, model.TaskDone)
	d := testutil.QueryTask(t, f.db, f.project, 403, model.TaskTodo)
	external := testutil.QueryTask(t, f.db, f.project, 404, model.TaskTodo)
	for _, edge := range [][2]string{{f.task, b.ID}, {f.task, c.ID}, {b.ID, d.ID}, {c.ID, d.ID}} {
		testutil.MustExec(t, f.db.Pool, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, f.project, edge[0], edge[1])
	}
	testutil.MustExec(t, f.db.Pool, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, f.project, f.task, external.ID)
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "7"))); err != nil {
		t.Fatal(err)
	}
	chain, err := f.service.Aggregate(ctx, f.actor, f.project, "chain", d.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if chain.Members.Total != "4" || chain.Members.WithKnownUsage != "1" || chain.Members.NoData != "3" || core.Value(chain.Summary.Metrics["outputTokens"].Known) != "7" {
		t.Fatalf("%+v", chain)
	}
	if chain.MembershipPolicy != "current_members_excludes_deleted" || chain.Members.Restricted != "0" {
		t.Fatal(chain)
	}
	goal := uuid.NewString()
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,type,title,description,status) VALUES($1,$2,'goal','Goal','','todo')`, goal, f.project)
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET parent_id=$1 WHERE id=ANY($2::uuid[])`, goal, []string{b.ID, d.ID})
	group, err := f.service.Aggregate(ctx, f.actor, f.project, "goal", goal, "")
	if err != nil {
		t.Fatal(err)
	}
	if group.Members.Total != "2" || group.Summary.Metrics["outputTokens"].Known != nil {
		t.Fatal("Goal expanded Chain", group)
	}
	previous := group.MembershipRevision
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET parent_id=NULL WHERE id=$1`, d.ID)
	group, err = f.service.Aggregate(ctx, f.actor, f.project, "goal", goal, "")
	if err != nil || group.Members.Total != "1" || group.MembershipRevision == previous {
		t.Fatal(group, err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, b.ID)
	group, err = f.service.Aggregate(ctx, f.actor, f.project, "goal", goal, "")
	if err != nil || group.Members.Total != "0" {
		t.Fatal(group, err)
	}
	_, outsider, _ := testutil.AuthRecords(t, f.db)
	_, err = f.service.Aggregate(ctx, outsider, f.project, "chain", f.task, "")
	requireCode(t, err, "aggregate_scope_restricted")
	_, err = f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task, external.ID, uuid.NewString()})
	requireCode(t, err, "resource_unavailable")
}
func TestUsagePermissionEpochInvalidatesDetailCursor(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1"), measurement(reg.State.ID, "2"))); err != nil {
		t.Fatal(err)
	}
	page, err := f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "measurement", Limit: 1})
	if err != nil || page.NextCursor == nil {
		t.Fatal(page, err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE team_members SET version=nextval('team_member_versions') WHERE user_id=$1`, f.actor.UserID)
	_, err = f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "measurement", Limit: 1, Cursor: *page.NextCursor})
	requireCode(t, err, "reset_required")
}
