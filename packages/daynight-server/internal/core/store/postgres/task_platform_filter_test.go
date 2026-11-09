package postgres

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskPlatformSpecificFiltersBeforePagination(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	rows := []model.Task{}
	for _, number := range []int{11, 12, 13, 14, 15} {
		rows = append(rows, queryTask(t, database, project.ID, number, model.TaskTodo))
	}
	instant := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	actor := queryID(100)
	mustQueryExec(t, database, "UPDATE tasks SET created_at=$1, allow_agents=true, assigned_to=$2", instant, actor)
	mustQueryExec(t, database, "UPDATE tasks SET required_platform='windows' WHERE id=$1", rows[1].ID)
	mustQueryExec(t, database, "UPDATE tasks SET required_platform='macos' WHERE id IN ($1,$2)", rows[2].ID, rows[4].ID)
	yes, no := true, false
	macos := model.PlatformMacOS
	for _, test := range []struct {
		name string
		tier *bool
		ids  []string
	}{
		{"compatible", nil, []string{rows[0].ID, rows[2].ID, rows[3].ID, rows[4].ID}},
		{"specific", &yes, []string{rows[2].ID, rows[4].ID}},
		{"unrestricted", &no, []string{rows[0].ID, rows[3].ID}},
	} {
		for _, bounded := range []bool{false, true} {
			t.Run(test.name+map[bool]string{false: "/ordinary", true: "/bounded"}[bounded], func(t *testing.T) {
				if err := database.ReadSnapshot(context.Background(), func(scope SnapshotScope) error {
					query := TaskQuery{Page: Page{Limit: 1}, Ready: &yes, AllowAgents: &yes, CompatiblePlatform: &macos, PlatformSpecific: test.tier, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: actor}, BoundedText: bounded}
					ids := []string{}
					for {
						page, err := scope.TaskDAO().Tasks(t.Context(), project.ID, query)
						if err != nil {
							return err
						}
						if len(page.Items) != 1 {
							t.Fatalf("page=%#v", page)
						}
						last := page.Items[0]
						ids = append(ids, last.ID)
						if !page.HasMore {
							break
						}
						if len(ids) >= len(test.ids) {
							t.Fatalf("unexpected extra page: %v", ids)
						}
						query.Page.After = &Position{CreatedAt: last.CreatedAt, ID: last.ID}
					}
					if !reflect.DeepEqual(ids, test.ids) {
						t.Fatalf("ids=%v want=%v", ids, test.ids)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
