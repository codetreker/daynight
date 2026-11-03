package service

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func serviceAssigneeItems(t *testing.T, result core.TaskAssignees, expected map[string]bool, unresolved []string) map[string]core.TaskAssignee {
	t.Helper()
	if result.Items == nil || result.UnresolvedUserIDs == nil || len(result.Items) != len(expected) {
		t.Fatalf("assignee result shape: %#v want %v", result, expected)
	}
	items := make(map[string]core.TaskAssignee, len(result.Items))
	var ids []string
	for _, item := range result.Items {
		access, exists := expected[item.UserID]
		if !exists || item.HasProjectAccess != access {
			t.Fatalf("wrong assignee qualification: %#v want %v", item, expected)
		}
		if _, duplicate := items[item.UserID]; duplicate {
			t.Fatal("assignee directory duplicated a person")
		}
		items[item.UserID] = item
		ids = append(ids, item.UserID)
	}
	wantUnresolved := append([]string{}, unresolved...)
	slices.Sort(wantUnresolved)
	if !slices.IsSorted(ids) || !slices.Equal(result.UnresolvedUserIDs, wantUnresolved) {
		t.Fatalf("directory ordering or unresolved scope: %#v want %v", result, wantUnresolved)
	}
	return items
}

func TestTaskAssigneesCatalogueAndResolutionScope(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	current := workerMember(t, database, project.ID)
	want := map[string]bool{admin.UserID: true, current.UserID: true}
	var historical []core.Task
	var formerIDs []string
	for _, status := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
		former := workerMember(t, database, project.ID)
		task := createAssignedTask(t, tasks, admin, project.ID, &former.UserID)
		task = setStatusTask(t, tasks, admin, task, status)
		historical = append(historical, task)
		if status == core.TaskTodo {
			createAssignedTask(t, tasks, admin, project.ID, &former.UserID)
		}
		if _, err := database.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, former.UserID); err != nil {
			t.Fatal(err)
		}
		want[former.UserID] = false
		formerIDs = append(formerIDs, former.UserID)
	}
	deletedOwner := workerMember(t, database, project.ID)
	deleted := createAssignedTask(t, tasks, admin, project.ID, &deletedOwner.UserID)
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, deleted.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, deletedOwner.UserID); err != nil {
		t.Fatal(err)
	}
	outsider := servicePrincipal(t, database)
	otherProject, err := NewProjects(database).Create(ctx, outsider, CreateProject{Name: "Other project", RepoURL: "host:other"})
	if err != nil {
		t.Fatal(err)
	}
	createAssignedTask(t, tasks, outsider, otherProject.ID, &outsider.UserID)
	name, avatar := "Canonical former profile", "https://images.example.test/former.png"
	if _, err := database.Pool.Exec(ctx, `UPDATE users SET name=$2,avatar_url=$3,email='private-directory@example.test' WHERE id=$1`, formerIDs[0], name, avatar); err != nil {
		t.Fatal(err)
	}
	catalogue, err := tasks.Assignees(ctx, admin, project.ID, TaskAssigneesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	items := serviceAssigneeItems(t, catalogue, want, nil)
	if items[current.UserID].Name != nil || items[current.UserID].AvatarURL != nil || !equalOptional(items[formerIDs[0]].Name, &name) || !equalOptional(items[formerIDs[0]].AvatarURL, &avatar) {
		t.Fatalf("nullable or canonical profiles changed: %#v", items)
	}
	memberView, err := tasks.Assignees(ctx, current, project.ID, TaskAssigneesRequest{})
	if err != nil || !reflect.DeepEqual(memberView, catalogue) {
		t.Fatal("ordinary member cannot read the same project-scoped directory", err)
	}
	missing := uuid.NewString()
	resolved, err := tasks.Assignees(ctx, admin, project.ID, TaskAssigneesRequest{UserIDs: []string{outsider.UserID, strings.ToUpper(current.UserID), formerIDs[0], missing, deletedOwner.UserID}})
	if err != nil {
		t.Fatal(err)
	}
	serviceAssigneeItems(t, resolved, map[string]bool{current.UserID: true, formerIDs[0]: false}, []string{outsider.UserID, missing, deletedOwner.UserID})
	for _, before := range historical {
		assertTaskUnchanged(t, tasks, admin, before)
	}
}

func TestTaskAssigneesDirectInputBoundsAndAuthorization(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	ids := make([]string, 101)
	for index := range ids {
		ids[index] = uuid.NewString()
	}
	for _, invalid := range [][]string{{}, {""}, {"me"}, {"unassigned"}, {"bad"}, {ids[0], ids[0]}, {ids[0], strings.ToUpper(ids[0])}, ids} {
		_, err := tasks.Assignees(ctx, admin, project.ID, TaskAssigneesRequest{UserIDs: invalid})
		requireFault(t, err, "invalid_input")
	}
	result, err := tasks.Assignees(ctx, admin, project.ID, TaskAssigneesRequest{UserIDs: ids[:100]})
	if err != nil {
		t.Fatal(err)
	}
	serviceAssigneeItems(t, result, map[string]bool{}, ids[:100])
	for _, bad := range []string{"", "bad"} {
		_, err := tasks.Assignees(ctx, admin, bad, TaskAssigneesRequest{})
		requireFault(t, err, "invalid_input")
	}
	_, err = tasks.Assignees(ctx, core.Principal{}, project.ID, TaskAssigneesRequest{})
	requireFault(t, err, "unauthenticated")
	for _, actor := range []core.Principal{servicePrincipal(t, database), admin} {
		projectID := project.ID
		if actor.UserID == admin.UserID {
			projectID = uuid.NewString()
		}
		result, err := tasks.Assignees(ctx, actor, projectID, TaskAssigneesRequest{})
		requireFault(t, err, "not_found")
		if len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
			t.Fatal("refused directory returned partial identities")
		}
	}
}

func TestTaskAssigneesReadOneMembershipAndProfileSnapshot(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		tasks, database, project, databaseURL, admin := taskService(t)
		ctx := context.Background()
		target := workerMember(t, database, project.ID)
		before := createAssignedTask(t, tasks, admin, project.ID, &target.UserID)
		oldName, newName := "Before snapshot", "After snapshot"
		if _, err := database.Pool.Exec(ctx, `UPDATE users SET name=$2 WHERE id=$1`, target.UserID, oldName); err != nil {
			t.Fatal(err)
		}
		var once sync.Once
		writes := 0
		traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM project_members m") }, end: func() {
			once.Do(func() {
				writes++
				if err := database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error { return tx.RemoveMember(ctx, target.UserID) }); err != nil {
					t.Fatal(err)
				}
				if _, err := database.Pool.Exec(ctx, `UPDATE users SET name=$2,updated_at=statement_timestamp() WHERE id=$1`, target.UserID, newName); err != nil {
					t.Fatal(err)
				}
			})
		}})
		request := TaskAssigneesRequest{}
		if resolve {
			request.UserIDs = []string{target.UserID}
		}
		old, err := traced.Assignees(ctx, admin, project.ID, request)
		if err != nil || writes != 1 {
			t.Fatalf("snapshot interleaving did not execute: writes=%d %v", writes, err)
		}
		oldExpected := map[string]bool{target.UserID: true}
		if !resolve {
			oldExpected[admin.UserID] = true
		}
		oldItems := serviceAssigneeItems(t, old, oldExpected, nil)
		if !equalOptional(oldItems[target.UserID].Name, &oldName) {
			t.Fatal("directory mixed old access with a new profile")
		}
		fresh, err := tasks.Assignees(ctx, admin, project.ID, request)
		if err != nil {
			t.Fatal(err)
		}
		oldExpected[target.UserID] = false
		freshItems := serviceAssigneeItems(t, fresh, oldExpected, nil)
		if !equalOptional(freshItems[target.UserID].Name, &newName) {
			t.Fatal("fresh read did not see the independently changed profile")
		}
		assertTaskUnchanged(t, tasks, admin, before)
	}
}

func TestTaskAssigneesReadOneAssignmentSnapshot(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		tasks, database, project, databaseURL, admin := taskService(t)
		ctx := context.Background()
		former := workerMember(t, database, project.ID)
		before := createAssignedTask(t, tasks, admin, project.ID, &former.UserID)
		if _, err := database.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, former.UserID); err != nil {
			t.Fatal(err)
		}
		var after core.Task
		var once sync.Once
		traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM project_members m") }, end: func() {
			once.Do(func() { after = updateTask(t, tasks, admin, before, UpdateTask{AssignedTo: assignmentChange(nil)}) })
		}})
		request := TaskAssigneesRequest{}
		if resolve {
			request.UserIDs = []string{former.UserID}
		}
		old, err := traced.Assignees(ctx, admin, project.ID, request)
		if err != nil || after.Version != before.Version+1 {
			t.Fatal("assignment snapshot interleaving failed", err)
		}
		want := map[string]bool{former.UserID: false}
		if !resolve {
			want[admin.UserID] = true
		}
		serviceAssigneeItems(t, old, want, nil)
		fresh, err := tasks.Assignees(ctx, admin, project.ID, request)
		if err != nil {
			t.Fatal(err)
		}
		if resolve {
			serviceAssigneeItems(t, fresh, map[string]bool{}, []string{former.UserID})
		} else {
			serviceAssigneeItems(t, fresh, map[string]bool{admin.UserID: true}, nil)
		}
		assertTaskUnchanged(t, tasks, admin, after)
	}
}

func TestTaskAssigneesReaderRemovalUsesSnapshotThenHidesProject(t *testing.T) {
	tasks, database, project, databaseURL, admin := taskService(t)
	ctx := context.Background()
	reader := workerMember(t, database, project.ID)
	var once sync.Once
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM project_members m") }, end: func() {
		once.Do(func() {
			if _, err := database.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, reader.UserID); err != nil {
				t.Fatal(err)
			}
		})
	}})
	old, err := traced.Assignees(ctx, reader, project.ID, TaskAssigneesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	serviceAssigneeItems(t, old, map[string]bool{admin.UserID: true, reader.UserID: true}, nil)
	fresh, err := tasks.Assignees(ctx, reader, project.ID, TaskAssigneesRequest{})
	requireFault(t, err, "not_found")
	if len(fresh.Items) != 0 || len(fresh.UnresolvedUserIDs) != 0 {
		t.Fatal("removed reader obtained directory identities")
	}
}

func TestTaskAssigneesFailuresNeverReturnPartialProfiles(t *testing.T) {
	query := func(sql string) bool {
		return strings.Contains(sql, "FROM candidate_ids candidate") || strings.Contains(sql, "FROM unnest($2::uuid[]) requested")
	}
	for _, resolve := range []bool{false, true} {
		for _, atEnd := range []bool{false, true} {
			_, database, project, databaseURL, admin := taskService(t)
			ctx, cancel := context.WithCancel(context.Background())
			action := taskQueryAction{match: query, start: cancel}
			if atEnd {
				action.start, action.end = nil, cancel
			}
			traced := tracedTasks(t, databaseURL, action)
			request := TaskAssigneesRequest{}
			if resolve {
				request.UserIDs = []string{admin.UserID}
			}
			result, err := traced.Assignees(ctx, admin, project.ID, request)
			cancel()
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
				t.Fatalf("failed directory leaked partial or lost cancellation: %#v %v", result, err)
			}
			if err := database.Pool.Ping(context.Background()); err != nil {
				t.Fatal("failed query leaked its connection", err)
			}
		}
	}
	for _, resolve := range []bool{false, true} {
		tasks, database, project, _, admin := taskService(t)
		if _, err := database.Pool.Exec(context.Background(), `DROP TABLE tasks CASCADE`); err != nil {
			t.Fatal(err)
		}
		request := TaskAssigneesRequest{}
		if resolve {
			request.UserIDs = []string{admin.UserID}
		}
		result, err := tasks.Assignees(context.Background(), admin, project.ID, request)
		assertOperational(t, err)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "42P01" || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
			t.Fatalf("storage failure became partial/empty success: %#v %v", result, err)
		}
	}
	tasks, database, project, databaseURL, _ := taskService(t)
	outsider := servicePrincipal(t, database)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM project_members m") }, end: cancel})
	result, err := traced.Assignees(ctx, outsider, project.ID, TaskAssigneesRequest{})
	assertOperational(t, err)
	if !errors.Is(err, context.Canceled) || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
		t.Fatal("transaction completion failure was hidden by project refusal", err)
	}
	_, err = tasks.Assignees(context.Background(), outsider, project.ID, TaskAssigneesRequest{})
	requireFault(t, err, "not_found")
}
