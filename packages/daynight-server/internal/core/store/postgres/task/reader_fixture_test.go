package task_test

import (
	"context"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func readerStore(t *testing.T) *postgres.Store {
	t.Helper()
	return testutil.OpenStore(t, postgres.Open)
}

func readerID(n int) string { return testutil.QueryID(n) }
func readerProject(t *testing.T, db *postgres.Store, n int) model.Project {
	t.Helper()
	return testutil.QueryProject(t, db.Pool, db, n)
}
func readerTask(t *testing.T, db *postgres.Store, project string, n int, status model.TaskStatus, deps ...string) model.Task {
	t.Helper()
	return testutil.QueryTask(t, db, project, n, status, deps...)
}
func readerSnapshotTask(t *testing.T, db *postgres.Store, project, id string) model.Task {
	t.Helper()
	return testutil.SnapshotTask(t, db, project, id)
}
func readerExec(t *testing.T, db *postgres.Store, sql string, args ...any) {
	t.Helper()
	testutil.MustExec(t, db.Pool, sql, args...)
}
func readerWriteProject(db *postgres.Store, ctx context.Context, project string, write func(ProjectWriteScope) error) error {
	return testutil.WriteProject(ctx, db, project, write)
}
func readerTaskProperties(t *testing.T, worker *model.WorkerClaim) model.TaskProperties {
	t.Helper()
	return testutil.TaskProperties(t, worker)
}
func readerPullRequests(t *testing.T, properties model.TaskProperties) []model.PullRequestProperty {
	t.Helper()
	return testutil.PullRequests(t, properties)
}
func readerPutProperty(t *testing.T, db *postgres.Store, id, name string, value []byte) {
	t.Helper()
	testutil.PutTaskProperty(t, db.Pool, id, name, value)
}
func readerAssigneeUser(t *testing.T, database *postgres.Store, projectID string, number int, member bool) string {
	t.Helper()
	id := readerID(number)
	readerExec(t, database, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,$1::uuid::text,now(),now())`, id)
	if member {
		readerExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, projectID, id)
	}
	return id
}

func readerAssigneeRead(t *testing.T, db *postgres.Store, project string, ids []string) ([]model.TaskAssigneeFact, error) {
	t.Helper()
	var facts []model.TaskAssigneeFact
	err := db.ReadSnapshot(t.Context(), func(snapshot SnapshotScope) error {
		var err error
		if ids == nil {
			facts, err = snapshot.TaskDAO().TaskAssignees(t.Context(), project)
		} else {
			facts, err = snapshot.TaskDAO().ResolveTaskAssignees(t.Context(), project, ids)
		}
		return err
	})
	return facts, err
}
func readerAssertAssignees(t *testing.T, facts []model.TaskAssigneeFact, expected map[string]bool, unresolved []string) {
	t.Helper()
	if facts == nil || len(facts) != len(expected)+len(unresolved) {
		t.Fatalf("assignee fact shape: %#v want %v unresolved %v", facts, expected, unresolved)
	}
	ids := make([]string, 0, len(facts))
	missing := make(map[string]bool, len(unresolved))
	for _, id := range unresolved {
		missing[id] = true
	}
	for _, fact := range facts {
		ids = append(ids, fact.UserID)
		if missing[fact.UserID] {
			if fact.Qualified || fact.HasProjectAccess || fact.ProfileID != nil || fact.Name != nil || fact.AvatarURL != nil {
				t.Fatalf("unqualified fact disclosed profile: %#v", fact)
			}
			continue
		}
		access, found := expected[fact.UserID]
		if !found || fact.HasProjectAccess != access || fact.ProfileID == nil || *fact.ProfileID != fact.UserID {
			t.Fatalf("unexpected qualified assignee fact: %#v", fact)
		}
	}
	if !slices.IsSorted(ids) || len(slices.Compact(slices.Clone(ids))) != len(ids) {
		t.Fatalf("identity order or uniqueness: %#v", facts)
	}
}
func readerMutationValues(value model.Task) TaskWrite { return testutil.TaskWrite(value) }

func readerWorkerClaim(number int, userID, workerID string, state model.WorkerState) *model.WorkerClaim {
	return testutil.WorkerClaim(number, userID, workerID, state)
}
