package task_test

import (
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
)

func TestTaskTagFiltersBeforeSelection(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a, b, c, goal, hidden := readerID(101), readerID(102), readerID(103), readerID(104), readerID(105)
	bug, backend := readerID(201), readerID(202)
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status,created_at,deleted_at) VALUES
	($1,$6,'task','A','todo','2020-01-03',NULL),($2,$6,'task','B','todo','2020-01-02',NULL),
	($3,$6,'task','C','todo','2020-01-01',NULL),($4,$6,'goal','D','todo','2020-01-04',NULL),
	($5,$6,'task','Hidden','todo','2020-01-01',now())`, a, b, c, goal, hidden, f.project)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET type='goal' WHERE id=$1;`, hidden)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,parent_id,created_at) VALUES($1,$2,'task','Hidden child',$3,'2019-01-01')`, readerID(106), f.project, hidden)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET parent_id=$2,assigned_to=$3 WHERE id=$1`, a, goal, f.user)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$3,'bug','bug',now(),now()),($2,$3,'backend','backend',now(),now())`, bug, backend, f.project)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$6),($1,$2,$7),($1,$3,$6),($1,$4,$7),($1,$5,$6)`, f.project, a, b, goal, hidden, bug, backend)
	mustOK(t, err)
	reader := task.NewReader(f.tx)
	_, err = f.tx.Exec(ctx, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$3)`, f.project, readerID(106), bug)
	mustOK(t, err)
	for _, tc := range []struct {
		name   string
		filter store.TagFilter
		kind   model.TaskType
		want   []string
	}{
		{"all", store.TagFilter{TagIDs: []string{bug, backend}, TagMatch: "all"}, model.TaskTypeTask, []string{a}},
		{"any", store.TagFilter{TagIDs: []string{bug, backend}, TagMatch: "any"}, model.TaskTypeTask, []string{b, a}},
		{"untagged", store.TagFilter{Untagged: true}, model.TaskTypeTask, []string{c}},
		{"goal", store.TagFilter{TagIDs: []string{bug, backend}, TagMatch: "any"}, model.TaskTypeGoal, []string{goal}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var ids []string
			var after *store.Position
			for {
				page, err := reader.Tasks(ctx, f.project, store.TaskQuery{TagFilter: tc.filter, Type: tc.kind, Page: store.Page{Limit: 1, After: after}})
				mustOK(t, err)
				for _, item := range page.Items {
					ids = append(ids, item.ID)
					after = &store.Position{CreatedAt: item.CreatedAt, ID: item.ID}
				}
				if !page.HasMore {
					break
				}
			}
			if !reflect.DeepEqual(ids, tc.want) {
				t.Fatalf("list %#v want %#v", ids, tc.want)
			}
			ready := true
			page, err := reader.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{TagFilter: tc.filter, Type: tc.kind, Ready: &ready, Limit: 1})
			mustOK(t, err)
			if tc.kind == model.TaskTypeGoal {
				if len(page.Items) != 0 {
					t.Fatalf("goal is ready: %#v", page)
				}
				return
			}
			if len(page.Items) != 1 || page.Items[0].Task.ID != tc.want[0] || page.HasMore != (len(tc.want) > 1) {
				t.Fatalf("priority pre-cap %#v want %#v", page, tc.want)
			}
		})
	}
	ready, status := true, model.TaskTodo
	selection := store.TaskQuery{TagFilter: store.TagFilter{TagIDs: []string{bug}, TagMatch: "any"}, Parent: &goal, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: f.user}, Status: &status, Ready: &ready, Page: store.Page{Limit: 1}}
	page, err := reader.Tasks(ctx, f.project, selection)
	mustOK(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != a {
		t.Fatalf("AND selection: %#v", page)
	}
	priority, err := reader.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{TagFilter: selection.TagFilter, Parent: selection.Parent, AssignedTo: selection.AssignedTo, Status: &status, Ready: &ready, Limit: 1})
	mustOK(t, err)
	if len(priority.Items) != 1 || priority.Items[0].Task.ID != a {
		t.Fatalf("AND priority: %#v", priority)
	}
	parent := "none"
	selection.Parent = &parent
	page, err = reader.Tasks(ctx, f.project, selection)
	mustOK(t, err)
	if len(page.Items) != 0 {
		t.Fatalf("parent scope widened: %#v", page)
	}
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET status='in_progress' WHERE id=$1`, b)
	mustOK(t, err)
	ready, status = false, model.TaskInProgress
	selection.Parent, selection.AssignedTo = nil, model.TaskAssignmentFilter{}
	page, err = reader.Tasks(ctx, f.project, selection)
	mustOK(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != b {
		t.Fatalf("status/readiness AND selection: %#v", page)
	}
}

func TestTaskTagQualificationAndSelectionShareSnapshot(t *testing.T) {
	db := readerStore(t)
	ctx := t.Context()
	project := readerProject(t, db, 1)
	item := readerTask(t, db, project.ID, 11, model.TaskTodo)
	tagID := readerID(21)
	readerExec(t, db, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'Tag','tag',now(),now())`, tagID, project.ID)
	readerExec(t, db, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$3)`, project.ID, item.ID, tagID)
	err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		tags, err := snapshot.TagDAO().ResolveTags(ctx, project.ID, []string{tagID})
		if err != nil {
			return err
		}
		if len(tags) != 1 {
			t.Fatalf("initial tag %#v", tags)
		}
		readerExec(t, db, `DELETE FROM task_tags WHERE project_id=$1 AND tag_id=$2`, project.ID, tagID)
		readerExec(t, db, `DELETE FROM project_tags WHERE project_id=$1 AND id=$2`, project.ID, tagID)
		page, err := snapshot.TaskDAO().Tasks(ctx, project.ID, store.TaskQuery{TagFilter: store.TagFilter{TagIDs: []string{tagID}, TagMatch: "all"}, Page: store.Page{Limit: 1}})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.Items[0].ID != item.ID {
			t.Fatalf("snapshot selection %#v", page)
		}
		return nil
	})
	mustOK(t, err)
	err = db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		tags, err := snapshot.TagDAO().ResolveTags(ctx, project.ID, []string{tagID})
		if err != nil {
			return err
		}
		if len(tags) != 0 {
			t.Fatalf("new snapshot retained deleted tag %#v", tags)
		}
		return nil
	})
	mustOK(t, err)
}
