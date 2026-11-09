package task_test

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func serviceAssigneeItems(t *testing.T, result model.TaskAssignees, expected map[string]bool, unresolved []string) map[string]model.TaskAssignee {
	t.Helper()
	if result.Items == nil || result.UnresolvedUserIDs == nil || len(result.Items) != len(expected) {
		t.Fatalf("assignee result shape: %#v want %v", result, expected)
	}
	items := make(map[string]model.TaskAssignee, len(result.Items))
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

func taskReadAssignee(id string, access bool, name, avatar *string) model.TaskAssigneeFact {
	return model.TaskAssigneeFact{UserID: id, ProfileID: &id, Qualified: true, HasProjectAccess: access, Name: name, AvatarURL: avatar}
}

func taskReadAssigneeFacts(facts ...model.TaskAssigneeFact) []model.TaskAssigneeFact {
	result := slices.Clone(facts)
	slices.SortFunc(result, func(a, b model.TaskAssigneeFact) int { return strings.Compare(a.UserID, b.UserID) })
	return result
}

func (f *taskReadFixture) assignees(facts []model.TaskAssigneeFact, requested []string) *taskservice.Tasks {
	f.reader.TaskAssigneesFn = nil
	f.reader.ResolveTaskAssigneesFn = nil
	if requested == nil {
		f.reader.TaskAssigneesFn = func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
			f.requireProject(ctx, id)
			return facts, nil
		}
	} else {
		f.reader.ResolveTaskAssigneesFn = func(ctx context.Context, id string, userIDs []string) ([]model.TaskAssigneeFact, error) {
			f.requireProject(ctx, id)
			if !slices.Equal(userIDs, requested) {
				f.t.Fatalf("resolved IDs=%v want=%v", userIDs, requested)
			}
			return facts, nil
		}
	}
	return taskservice.NewTasks(f.store)
}

func TestTaskAssigneesCatalogueAndResolutionScope(t *testing.T) {
	f := newTaskReadFixture(t)
	current := taskReadID(20)
	formerIDs := []string{taskReadID(21), taskReadID(22), taskReadID(23)}
	outsider, missing, deletedOwner := taskReadID(30), taskReadID(99), taskReadID(40)
	name, avatar := "Canonical former profile", "https://images.example.test/former.png"
	facts := taskReadAssigneeFacts(taskReadAssignee(f.principal.UserID, true, nil, nil), taskReadAssignee(current, true, nil, nil), taskReadAssignee(formerIDs[0], false, &name, &avatar), taskReadAssignee(formerIDs[1], false, nil, nil), taskReadAssignee(formerIDs[2], false, nil, nil))
	want := map[string]bool{f.principal.UserID: true, current: true, formerIDs[0]: false, formerIDs[1]: false, formerIDs[2]: false}
	tasks := f.assignees(facts, nil)
	catalogue, err := tasks.Assignees(f.ctx, f.principal, f.project.ID, taskservice.TaskAssigneesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	items := serviceAssigneeItems(t, catalogue, want, nil)
	if items[current].Name != nil || items[current].AvatarURL != nil || !model.EqualOptional(items[formerIDs[0]].Name, &name) || !model.EqualOptional(items[formerIDs[0]].AvatarURL, &avatar) {
		t.Fatalf("nullable or canonical profiles changed: %#v", items)
	}
	member := f.principal
	member.UserID = current
	f.projectReader.ProjectAccessFn = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		f.requireProject(ctx, id)
		if p != member {
			t.Fatal("member identity changed")
		}
		access := taskMockAccess(f.project, p)
		access.Role = model.ProjectMemberRole
		return access, nil
	}
	memberView, err := tasks.Assignees(f.ctx, member, f.project.ID, taskservice.TaskAssigneesRequest{})
	if err != nil || !reflect.DeepEqual(memberView, catalogue) {
		t.Fatal("ordinary member cannot read the same scoped directory", err)
	}
	admin := f.principal
	f.projectReader.ProjectAccessFn = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		f.requireProject(ctx, id)
		if p != admin {
			t.Fatal("resolution actor changed")
		}
		return taskMockAccess(f.project, p), nil
	}
	request := []string{outsider, strings.ToUpper(current), formerIDs[0], missing, deletedOwner}
	wantIDs := slices.Clone(request)
	for index := range wantIDs {
		wantIDs[index] = strings.ToLower(wantIDs[index])
	}
	slices.Sort(wantIDs)
	resolution := taskReadAssigneeFacts(taskReadAssignee(current, true, nil, nil), taskReadAssignee(formerIDs[0], false, &name, &avatar), model.TaskAssigneeFact{UserID: outsider}, model.TaskAssigneeFact{UserID: missing}, model.TaskAssigneeFact{UserID: deletedOwner})
	resolved, err := f.assignees(resolution, wantIDs).Assignees(f.ctx, admin, f.project.ID, taskservice.TaskAssigneesRequest{UserIDs: request})
	if err != nil {
		t.Fatal(err)
	}
	serviceAssigneeItems(t, resolved, map[string]bool{current: true, formerIDs[0]: false}, []string{outsider, missing, deletedOwner})
	if f.reads != 3 {
		t.Fatalf("directory requests used %d snapshots", f.reads)
	}
}

func TestTaskAssigneesDirectInputBoundsAndAuthorization(t *testing.T) {
	f := newTaskReadFixture(t)
	tasks := taskservice.NewTasks(f.store)
	ids := make([]string, 101)
	for index := range ids {
		ids[index] = taskReadID(index + 1)
	}
	for _, invalid := range [][]string{{}, {""}, {"me"}, {"unassigned"}, {"bad"}, {ids[0], ids[0]}, {ids[0], strings.ToUpper(ids[0])}, ids} {
		_, err := tasks.Assignees(f.ctx, f.principal, f.project.ID, taskservice.TaskAssigneesRequest{UserIDs: invalid})
		requireFault(t, err, "invalid_input")
	}
	for _, bad := range []string{"", "bad"} {
		_, err := tasks.Assignees(f.ctx, f.principal, bad, taskservice.TaskAssigneesRequest{})
		requireFault(t, err, "invalid_input")
	}
	_, err := tasks.Assignees(f.ctx, model.Principal{}, f.project.ID, taskservice.TaskAssigneesRequest{})
	requireFault(t, err, "unauthenticated")
	if f.reads != 0 {
		t.Fatal("invalid directory input reached storage")
	}
	unqualified := make([]model.TaskAssigneeFact, 100)
	for index, id := range ids[:100] {
		unqualified[index] = model.TaskAssigneeFact{UserID: id}
	}
	result, err := f.assignees(unqualified, ids[:100]).Assignees(f.ctx, f.principal, f.project.ID, taskservice.TaskAssigneesRequest{UserIDs: ids[:100]})
	if err != nil {
		t.Fatal(err)
	}
	serviceAssigneeItems(t, result, map[string]bool{}, ids[:100])
	for _, missingProject := range []bool{false, true} {
		f := newTaskReadFixture(t)
		actor, id := f.principal, f.project.ID
		if missingProject {
			id = taskReadID(99)
		} else {
			actor.UserID = taskReadID(98)
		}
		f.projectReader.ProjectAccessFn = func(ctx context.Context, p model.Principal, projectID string) (model.ProjectAccess, error) {
			f.requireActive()
			if ctx != f.ctx || p != actor || projectID != id {
				t.Fatal("refused directory identity changed")
			}
			return model.ProjectAccess{}, model.ErrNotFound
		}
		result, err := taskservice.NewTasks(f.store).Assignees(f.ctx, actor, id, taskservice.TaskAssigneesRequest{})
		requireFault(t, err, "not_found")
		if !reflect.DeepEqual(result, model.TaskAssignees{}) {
			t.Fatal("refused directory returned partial identities")
		}
	}
}

func TestTaskAssigneesReadOneMembershipAndProfileSnapshot(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		f := newTaskReadFixture(t)
		target := taskReadID(20)
		oldName, newName := "Before snapshot", "After snapshot"
		var requested []string
		if resolve {
			requested = []string{target}
		}
		before := []model.TaskAssigneeFact{taskReadAssignee(target, true, &oldName, nil)}
		after := []model.TaskAssigneeFact{taskReadAssignee(target, false, &newName, nil)}
		oldExpected := map[string]bool{target: true}
		freshExpected := map[string]bool{target: false}
		if !resolve {
			before = taskReadAssigneeFacts(append(before, taskReadAssignee(f.principal.UserID, true, nil, nil))...)
			after = taskReadAssigneeFacts(append(after, taskReadAssignee(f.principal.UserID, true, nil, nil))...)
			oldExpected[f.principal.UserID] = true
			freshExpected[f.principal.UserID] = true
		}
		request := taskservice.TaskAssigneesRequest{UserIDs: requested}
		old, err := f.assignees(before, requested).Assignees(f.ctx, f.principal, f.project.ID, request)
		if err != nil || f.reads != 1 {
			t.Fatalf("one original scope: %d %v", f.reads, err)
		}
		oldItems := serviceAssigneeItems(t, old, oldExpected, nil)
		fresh, err := f.assignees(after, requested).Assignees(f.ctx, f.principal, f.project.ID, request)
		if err != nil || f.reads != 2 {
			t.Fatalf("one fresh scope: %d %v", f.reads, err)
		}
		freshItems := serviceAssigneeItems(t, fresh, freshExpected, nil)
		if !model.EqualOptional(oldItems[target].Name, &oldName) || !model.EqualOptional(freshItems[target].Name, &newName) || !model.EqualOptional(old.Items[0].Name, &oldName) {
			t.Fatal("membership and profile scope fields were mixed or old response changed")
		}
	}
}

func TestTaskAssigneesReadOneAssignmentSnapshot(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		f := newTaskReadFixture(t)
		former := taskReadID(20)
		var requested []string
		if resolve {
			requested = []string{former}
		}
		before := []model.TaskAssigneeFact{taskReadAssignee(former, false, nil, nil)}
		var after []model.TaskAssigneeFact
		beforeExpected := map[string]bool{former: false}
		if resolve {
			after = []model.TaskAssigneeFact{{UserID: former}}
		} else {
			before = taskReadAssigneeFacts(append(before, taskReadAssignee(f.principal.UserID, true, nil, nil))...)
			after = []model.TaskAssigneeFact{taskReadAssignee(f.principal.UserID, true, nil, nil)}
			beforeExpected[f.principal.UserID] = true
		}
		request := taskservice.TaskAssigneesRequest{UserIDs: requested}
		old, err := f.assignees(before, requested).Assignees(f.ctx, f.principal, f.project.ID, request)
		if err != nil || f.reads != 1 {
			t.Fatalf("original assignment scope: %v", err)
		}
		serviceAssigneeItems(t, old, beforeExpected, nil)
		fresh, err := f.assignees(after, requested).Assignees(f.ctx, f.principal, f.project.ID, request)
		if err != nil || f.reads != 2 {
			t.Fatalf("fresh assignment scope: %v", err)
		}
		if resolve {
			serviceAssigneeItems(t, fresh, map[string]bool{}, []string{former})
		} else {
			serviceAssigneeItems(t, fresh, map[string]bool{f.principal.UserID: true}, nil)
		}
		serviceAssigneeItems(t, old, beforeExpected, nil)
	}
}

func TestTaskAssigneesReaderRemovalUsesSnapshotThenHidesProject(t *testing.T) {
	f := newTaskReadFixture(t)
	reader := f.principal
	reader.UserID = taskReadID(20)
	f.principal = reader
	admin := taskReadID(21)
	old, err := f.assignees(taskReadAssigneeFacts(taskReadAssignee(admin, true, nil, nil), taskReadAssignee(reader.UserID, true, nil, nil)), nil).Assignees(f.ctx, reader, f.project.ID, taskservice.TaskAssigneesRequest{})
	if err != nil || f.reads != 1 {
		t.Fatal(err)
	}
	serviceAssigneeItems(t, old, map[string]bool{admin: true, reader.UserID: true}, nil)
	f.projectReader.ProjectAccessFn = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		f.requireProject(ctx, id)
		if p != reader {
			t.Fatal("removed actor changed")
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}
	f.reader.TaskAssigneesFn = nil
	fresh, err := taskservice.NewTasks(f.store).Assignees(f.ctx, reader, f.project.ID, taskservice.TaskAssigneesRequest{})
	requireFault(t, err, "not_found")
	if !reflect.DeepEqual(fresh, model.TaskAssignees{}) || f.reads != 2 {
		t.Fatal("removed reader obtained directory identities")
	}
}

func TestTaskAssigneesFailuresNeverReturnPartialProfiles(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		for _, atEnd := range []bool{false, true} {
			f := newTaskReadFixture(t)
			ctx, cancel := context.WithCancel(f.ctx)
			defer cancel()
			f.ctx = ctx
			request := taskservice.TaskAssigneesRequest{}
			var requested []string
			if resolve {
				requested = []string{f.principal.UserID}
				request.UserIDs = requested
			}
			tasks := f.assignees(nil, requested)
			failure := func() ([]model.TaskAssigneeFact, error) {
				cancel()
				var rows []model.TaskAssigneeFact
				if atEnd {
					rows = []model.TaskAssigneeFact{taskReadAssignee(f.principal.UserID, true, nil, nil)}
				}
				return rows, ctx.Err()
			}
			if resolve {
				f.reader.ResolveTaskAssigneesFn = func(got context.Context, id string, ids []string) ([]model.TaskAssigneeFact, error) {
					f.requireProject(got, id)
					if !slices.Equal(ids, requested) {
						t.Fatal("failed resolution IDs changed")
					}
					return failure()
				}
			} else {
				f.reader.TaskAssigneesFn = func(got context.Context, id string) ([]model.TaskAssigneeFact, error) {
					f.requireProject(got, id)
					return failure()
				}
			}
			result, err := tasks.Assignees(ctx, f.principal, f.project.ID, request)
			var fault *model.Fault
			if !errors.Is(err, context.Canceled) || errors.As(err, &fault) || !reflect.DeepEqual(result, model.TaskAssignees{}) {
				t.Fatalf("directory failure leaked partial rows or cause: %#v %v", result, err)
			}
		}
		f := newTaskReadFixture(t)
		storage := errors.New("directory storage failure")
		request := taskservice.TaskAssigneesRequest{}
		var requested []string
		if resolve {
			requested = []string{f.principal.UserID}
			request.UserIDs = requested
		}
		tasks := f.assignees(nil, requested)
		if resolve {
			f.reader.ResolveTaskAssigneesFn = func(ctx context.Context, id string, ids []string) ([]model.TaskAssigneeFact, error) {
				f.requireProject(ctx, id)
				if !slices.Equal(ids, requested) {
					t.Fatal("failed resolution changed")
				}
				return nil, storage
			}
		} else {
			f.reader.TaskAssigneesFn = func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
				f.requireProject(ctx, id)
				return nil, storage
			}
		}
		result, err := tasks.Assignees(f.ctx, f.principal, f.project.ID, request)
		var fault *model.Fault
		if !errors.Is(err, storage) || errors.As(err, &fault) || !reflect.DeepEqual(result, model.TaskAssignees{}) {
			t.Fatalf("storage failure became partial success or refusal: %#v %v", result, err)
		}
	}
}
