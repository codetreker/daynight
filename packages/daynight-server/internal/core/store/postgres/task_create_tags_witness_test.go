package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	tasktext "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestCreateTagsPersistAndRejectAtomically(t *testing.T) {
	s, principal, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at)
        SELECT gen_random_uuid(),$1,format('tag-%s',n),format('tag-%s',n),statement_timestamp(),statement_timestamp() FROM generate_series(1,400) n`, project.ID)
	rows, err := s.Pool.Query(ctx, `SELECT id::text,name FROM project_tags WHERE project_id=$1 ORDER BY id`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	var refs []model.TagReference
	for rows.Next() {
		var ref model.TagReference
		if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		ids = append(ids, ref.ID)
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	tasks := taskservice.NewTasks(s)
	selected := []string{ids[1], ids[0], ids[1]}
	goal, err := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Type: model.TaskTypeGoal, Title: "tagged goal", TagIDs: &selected})
	if err != nil || goal.Version != 1 || !reflect.DeepEqual(goal.Tags, refs[:2]) {
		t.Fatalf("goal receipt: %#v %v", goal, err)
	}
	child, err := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "untagged child", ParentID: &goal.ID})
	if err != nil || len(child.Tags) != 0 || child.ParentID == nil || *child.ParentID != goal.ID {
		t.Fatalf("child receipt: %#v %v", child, err)
	}
	readGoal := snapshotTask(t, s, project.ID, goal.ID)
	readChild := snapshotTask(t, s, project.ID, child.ID)
	if !reflect.DeepEqual(readGoal.Tags, refs[:2]) || len(readChild.Tags) != 0 {
		t.Fatalf("independent readback goal=%#v child=%#v", readGoal.Tags, readChild.Tags)
	}

	otherProject := queryProject(t, s, 91)
	foreignID := queryID(92)
	mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'foreign','foreign',statement_timestamp(),statement_timestamp())`, foreignID, otherProject.ID)
	for i, bad := range []string{queryID(93), foreignID} {
		input := []string{ids[0], bad}
		title := fmt.Sprintf("invalid-create-%d", i)
		_, err := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: title, TagIDs: &input})
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "tag_not_found" {
			t.Fatalf("invalid tag: %v", err)
		}
		var count int
		if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE project_id=$1 AND title=$2`, project.ID, title).Scan(&count); err != nil || count != 0 {
			t.Fatalf("invalid create persisted %d: %v", count, err)
		}
	}
	var associationsBefore int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1`, project.ID).Scan(&associationsBefore); err != nil {
		t.Fatal(err)
	}
	_, err = tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "capacity-create", Description: strings.Repeat("&", tasktext.MaxDescriptionBytes), TagIDs: &ids})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("capacity refusal: %v", err)
	}
	var taskCount, associationCount int
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM tasks WHERE project_id=$1 AND title='capacity-create'), (SELECT count(*) FROM task_tags WHERE project_id=$1)`, project.ID).Scan(&taskCount, &associationCount); err != nil || taskCount != 0 || associationCount != associationsBefore {
		t.Fatalf("capacity rollback task=%d tags=%d (before %d): %v", taskCount, associationCount, associationsBefore, err)
	}
}
