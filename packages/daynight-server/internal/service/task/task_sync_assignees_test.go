package task_test

import (
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func syncAssigneeVersions(t *testing.T, value model.TaskSync) map[string]model.TaskAssigneeVersion {
	t.Helper()
	if value.AssigneeVersions == nil {
		t.Fatal("sync omitted the complete people version manifest")
	}
	result := make(map[string]model.TaskAssigneeVersion, len(value.AssigneeVersions))
	ids := make([]string, 0, len(value.AssigneeVersions))
	for _, entry := range value.AssigneeVersions {
		if len(entry.Version) != 64 || result[entry.UserID].UserID != "" {
			t.Fatalf("invalid or duplicate assignee version: %#v", entry)
		}
		result[entry.UserID] = entry
		ids = append(ids, entry.UserID)
	}
	if !slices.IsSorted(ids) {
		t.Fatalf("unsorted people version manifest: %v", ids)
	}
	return result
}

func TestTaskSyncAssigneeVersionsTrackContentAndLiveQualification(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	member := workerMember(t, database, project.ID)
	former := workerMember(t, database, project.ID)
	retained := createAssignedTask(t, tasks, admin, project.ID, &former.UserID)
	other := servicePrincipal(t, database)
	sync := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second)
	read := func() (model.TaskSync, map[string]model.TaskAssigneeVersion) {
		t.Helper()
		result, err := sync.Get(ctx, admin, project.ID, taskservice.TaskSyncRequest{})
		if err != nil {
			t.Fatal(err)
		}
		return result, syncAssigneeVersions(t, result)
	}
	baseline, initial := read()
	if len(initial) != 3 || !initial[member.UserID].HasProjectAccess || initial[other.UserID].UserID != "" {
		t.Fatalf("manifest did not match scoped catalogue: %#v", initial)
	}
	catalogue, err := tasks.Assignees(ctx, admin, project.ID, taskservice.TaskAssigneesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, person := range catalogue.Items {
		if initial[person.UserID].Version != person.Version {
			t.Fatal("sync and people GET disagree on the same profile version")
		}
	}
	var user model.User
	_, err = database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		var err error
		user, _, err = scope.IdentityDAO().IdentityUser(ctx, member.UserID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	fixtureIdentitySession(t, database, user, model.Session{ID: uuid.NewString(), TokenHash: secretutil.Hash(secretutil.Random("dnst_")), CreatedAt: now, ExpiresAt: now.Add(identitycore.SessionLifetime)})

	if _, err := database.Pool.Exec(ctx, `UPDATE project_grants SET role='admin',version=version+1 WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE users SET email='not-exposed@example.test' WHERE id=$1`, member.UserID); err != nil {
		t.Fatal(err)
	}
	retained = updateTask(t, tasks, admin, retained, taskcore.UpdateTask{Title: pointer("Unrelated task edit")})
	unchanged, stable := read()
	if !reflect.DeepEqual(stable, initial) || unchanged.Tasks[0].Version == baseline.Tasks[0].Version {
		t.Fatalf("login, role or task changes invalidated profile content: %#v", stable)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE users SET name='Changed <&> 中文',avatar_url='data:image/png;base64,changed',email='private@example.test' WHERE id=$1`, member.UserID); err != nil {
		t.Fatal(err)
	}
	_, changed := read()
	if changed[member.UserID].Version == stable[member.UserID].Version || changed[admin.UserID] != stable[admin.UserID] || changed[former.UserID] != stable[former.UserID] {
		t.Fatalf("profile change did not invalidate only its own content: %#v", changed)
	}
	if _, err := database.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, former.UserID); err != nil {
		t.Fatal(err)
	}
	_, lostAccess := read()
	if lostAccess[former.UserID].HasProjectAccess || lostAccess[former.UserID].Version != initial[former.UserID].Version {
		t.Fatalf("access-only change invalidated retained profile content: %#v", lostAccess[former.UserID])
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, retained.ID); err != nil {
		t.Fatal(err)
	}
	_, removed := read()
	if _, exists := removed[former.UserID]; exists {
		t.Fatal("deleted-only assignment remained a qualified profile")
	}
	if err := writeProjectForTest(database, ctx, project.ID, func(tx store.ProjectWriteScope) error {
		_, err := tx.ProjectDAO().AddInvitedMember(ctx, former.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	_, restored := read()
	if restored[former.UserID] != initial[former.UserID] {
		t.Fatal("access restoration changed an unchanged profile version")
	}
}

func TestTaskSyncAssigneeVersionsUseTheTaskSnapshot(t *testing.T) {
	tasks, database, project, databaseURL, admin := taskService(t)
	ctx := context.Background()
	member := workerMember(t, database, project.ID)
	unreferenced := workerMember(t, database, project.ID)
	task := createAssignedTask(t, tasks, admin, project.ID, &member.UserID)
	baseline, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second).Get(ctx, admin, project.ID, taskservice.TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	initial := syncAssigneeVersions(t, baseline)
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "SELECT count(*) FROM tasks") }, end: func() {
		updateTask(t, tasks, admin, task, taskcore.UpdateTask{Title: pointer("Changed in another transaction")})
		if _, err := database.Pool.Exec(ctx, `UPDATE users SET name='Fresh profile' WHERE id=$1`, member.UserID); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=ANY($2::uuid[])`, project.ID, []string{member.UserID, unreferenced.UserID}); err != nil {
			t.Fatal(err)
		}
	}})
	old, err := taskservice.NewTaskSync(traced.store, sessioncore.NewEngine(nil), 10*time.Second).Get(ctx, admin, project.ID, taskservice.TaskSyncRequest{Epoch: baseline.Epoch})
	if err != nil || !reflect.DeepEqual(syncAssigneeVersions(t, old), initial) || old.Tasks[0].TitlePreview != task.Title {
		t.Fatalf("task-sync mixed people and task snapshots: %#v %v", old, err)
	}
	fresh, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second).Get(ctx, admin, project.ID, taskservice.TaskSyncRequest{Epoch: baseline.Epoch})
	if err != nil {
		t.Fatal(err)
	}
	versions := syncAssigneeVersions(t, fresh)
	if versions[member.UserID].Version == initial[member.UserID].Version || versions[member.UserID].HasProjectAccess || versions[unreferenced.UserID].UserID != "" || fresh.Tasks[0].TitlePreview == task.Title {
		t.Fatalf("fresh snapshot missed people or task changes: %#v", fresh)
	}
}

func TestTaskSyncAssigneeIntegrityFailureReturnsNoSnapshot(t *testing.T) {
	_, database, project, _, admin := taskService(t)
	member := workerMember(t, database, project.ID)
	if _, err := database.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, member.UserID); err != nil {
		t.Fatal(err)
	}
	result, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second).Get(context.Background(), admin, project.ID, taskservice.TaskSyncRequest{})
	assertOperational(t, err)
	if !reflect.DeepEqual(result, model.TaskSync{}) {
		t.Fatalf("missing qualified profile produced a partial task snapshot: %#v", result)
	}
}
