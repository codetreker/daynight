package task_test

import (
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
)

func TestCandidateTagNamesBeforePagination(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	untagged, one, both, foreign, goal, child, denied := readerID(101), readerID(102), readerID(103), readerID(104), readerID(105), readerID(106), readerID(107)
	backend, urgent, foreignBackend := readerID(201), readerID(202), readerID(203)
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status,created_at,allow_agents,assigned_to) VALUES
		($1,$8,'task','untagged','todo','2020-01-01',true,$10),
		($2,$8,'task','one','todo','2020-01-02',true,$10),
		($3,$8,'task','both','todo','2020-01-03',true,$10),
		($4,$9,'task','foreign','todo','2020-01-04',true,$10),
		($5,$8,'goal','goal','todo','2020-01-05',true,$10),
		($6,$8,'task','child','todo','2020-01-06',true,$10),
		($7,$8,'task','denied','todo','2020-01-07',false,$10)`, untagged, one, both, foreign, goal, child, denied, f.project, f.other, f.user)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, child)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES
		($1,$4,'Backend','backend',now(),now()),($2,$4,'Urgent','urgent',now(),now()),($3,$5,'backend','backend',now(),now())`, backend, urgent, foreignBackend, f.project, f.other)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES
		($1,$3,$7),($1,$4,$7),($1,$4,$8),($1,$5,$7),($1,$6,$7),($2,$9,$10)`, f.project, f.other, one, both, goal, denied, backend, urgent, foreign, foreignBackend)
	mustOK(t, err)
	reader := task.NewReader(f.tx)
	ready, allowed := true, true
	base := store.TaskQuery{Page: store.Page{Limit: 1}, AutomaticCandidate: true, Ready: &ready, AllowAgents: &allowed, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: f.user}}
	for _, tc := range []struct {
		name    string
		project string
		filter  model.TagNameFilter
		want    []string
	}{
		{"any with absent name", f.project, model.TagNameFilter{Names: []string{" BACKEND ", "missing"}, Match: "any"}, []string{one, both}},
		{"all", f.project, model.TagNameFilter{Names: []string{"urgent", "Backend"}, Match: "all"}, []string{both}},
		{"all missing", f.project, model.TagNameFilter{Names: []string{"backend", "missing"}, Match: "all"}, []string{}},
		{"empty", f.project, model.TagNameFilter{Names: []string{}, Match: "any"}, []string{untagged, one, both, child}},
		{"same name other project", f.other, model.TagNameFilter{Names: []string{"Backend"}, Match: "any"}, []string{foreign}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query := base
			query.CandidateTagFilter = &tc.filter
			ids := []string{}
			for {
				page, err := reader.Tasks(ctx, tc.project, query)
				mustOK(t, err)
				for _, item := range page.Items {
					ids = append(ids, item.ID)
					query.Page.After = &store.Position{CreatedAt: item.CreatedAt, ID: item.ID}
				}
				if !page.HasMore {
					break
				}
				if len(page.Items) == 0 {
					t.Fatal("empty page marked as having more")
				}
			}
			if !reflect.DeepEqual(ids, tc.want) {
				t.Fatalf("candidate IDs %v, want %v", ids, tc.want)
			}
		})
	}
}
