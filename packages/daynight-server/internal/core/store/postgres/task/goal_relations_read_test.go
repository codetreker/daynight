package task_test

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestGoalRelationReaderClassifiesSameProjectEndpoints(t *testing.T) {
	db := readerStore(t)
	project := readerProject(t, db, 1)
	otherProject := readerProject(t, db, 2)
	downstream, upstream, edge := readerID(11), readerID(12), readerID(21)
	externalUpstream := readerID(13)
	readerExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$3,'goal','Downstream','todo'),($2,$3,'goal','Upstream','done')`, downstream, upstream, project.ID)
	readerExec(t, db, `UPDATE project_ownership SET team_id=(SELECT team_id FROM project_ownership WHERE project_id=$1) WHERE project_id=$2`, project.ID, otherProject.ID)
	readerExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','External upstream','done')`, externalUpstream, otherProject.ID)
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, project.ID, downstream, upstream, edge)
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, project.ID, downstream, externalUpstream, readerID(22))
	var userID string
	if err := db.Pool.QueryRow(t.Context(), `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1 LIMIT 1`, project.ID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		dao := snapshot.GoalRelationDAO()
		prerequisites, err := dao.Prerequisites(t.Context(), project.ID, downstream, userID)
		if err != nil {
			return err
		}
		if len(prerequisites) != 2 || prerequisites[0].ID != edge || prerequisites[0].Target == nil || prerequisites[0].Target.GoalID != upstream || prerequisites[0].Target.ProjectID != project.ID || prerequisites[0].Target.Kind != "internal" {
			t.Fatalf("same-project prerequisite: %+v", prerequisites)
		}
		if prerequisites[1].Target == nil || prerequisites[1].Target.GoalID != externalUpstream || prerequisites[1].Target.ProjectID != otherProject.ID || prerequisites[1].Target.Kind != "external" {
			t.Fatalf("cross-project prerequisite: %+v", prerequisites[1])
		}
		successors, err := dao.Successors(t.Context(), project.ID, upstream, userID, "", 20)
		if err != nil {
			return err
		}
		if len(successors) != 1 || successors[0].GoalID != downstream || successors[0].ProjectID != project.ID || successors[0].Kind != "internal" {
			t.Fatalf("same-project successor: %+v", successors)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
