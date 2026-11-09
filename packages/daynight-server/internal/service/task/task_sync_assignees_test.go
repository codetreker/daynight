package task_test

import (
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
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
	f := newTaskReadFixture(t)
	epoch := taskReadID(90)
	member, former, other := taskReadID(20), taskReadID(21), taskReadID(30)
	row := taskReadView(taskReadID(1), "Assigned task", 1, f.observed)
	row.AssignedTo = &former
	initialFacts := taskReadAssigneeFacts(taskReadAssignee(f.principal.UserID, true, nil, nil), taskReadAssignee(member, true, nil, nil), taskReadAssignee(former, true, nil, nil))
	read := func(task model.TaskViewRecord, facts []model.TaskAssigneeFact) (model.TaskSync, map[string]model.TaskAssigneeVersion) {
		t.Helper()
		sync := f.sync(epoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
			if lower != nil {
				t.Fatal("full people snapshot acquired a window")
			}
			return []model.TaskViewRecord{task}, nil
		}, facts, 10*time.Second)
		result, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{})
		if err != nil {
			t.Fatal(err)
		}
		return result, syncAssigneeVersions(t, result)
	}
	baseline, initial := read(row, initialFacts)
	if len(initial) != 3 || !initial[member].HasProjectAccess || initial[other].UserID != "" {
		t.Fatalf("manifest did not match scoped catalogue: %#v", initial)
	}
	catalogue, err := taskservice.NewTasks(f.store).Assignees(f.ctx, f.principal, f.project.ID, taskservice.TaskAssigneesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, person := range catalogue.Items {
		if initial[person.UserID].Version != person.Version {
			t.Fatal("Sync and people GET disagree on profile content")
		}
	}
	changedRow := row
	changedRow.Version++
	changedRow.TitlePreview = "Unrelated task edit"
	unchanged, stable := read(changedRow, initialFacts)
	if !reflect.DeepEqual(stable, initial) || unchanged.Tasks[0].Version == baseline.Tasks[0].Version {
		t.Fatalf("unrelated task signal changed public profiles: %#v", stable)
	}
	name, avatar := "Changed <&> 中文", "data:image/png;base64,changed"
	changedFacts := taskReadAssigneeFacts(taskReadAssignee(f.principal.UserID, true, nil, nil), taskReadAssignee(member, true, &name, &avatar), taskReadAssignee(former, true, nil, nil))
	_, changed := read(changedRow, changedFacts)
	if changed[member].Version == stable[member].Version || changed[f.principal.UserID] != stable[f.principal.UserID] || changed[former] != stable[former] {
		t.Fatalf("profile change did not invalidate only its content: %#v", changed)
	}
	lostFacts := taskReadAssigneeFacts(taskReadAssignee(f.principal.UserID, true, nil, nil), taskReadAssignee(member, true, &name, &avatar), taskReadAssignee(former, false, nil, nil))
	_, lostAccess := read(changedRow, lostFacts)
	if lostAccess[former].HasProjectAccess || lostAccess[former].Version != initial[former].Version {
		t.Fatalf("access changed retained profile content: %#v", lostAccess[former])
	}
	removedFacts := taskReadAssigneeFacts(taskReadAssignee(f.principal.UserID, true, nil, nil), taskReadAssignee(member, true, &name, &avatar))
	_, removed := read(changedRow, removedFacts)
	if _, exists := removed[former]; exists {
		t.Fatal("unqualified person remained in complete manifest")
	}
	_, restored := read(changedRow, changedFacts)
	if restored[former] != initial[former] {
		t.Fatal("restored access changed unchanged profile version")
	}
	if !reflect.DeepEqual(syncAssigneeVersions(t, baseline), initial) {
		t.Fatal("later scope changed baseline manifest")
	}
}

func TestTaskSyncAssigneeVersionsUseTheTaskSnapshot(t *testing.T) {
	f := newTaskReadFixture(t)
	epoch := taskReadID(90)
	member, unreferenced := taskReadID(20), taskReadID(21)
	task := taskReadView(taskReadID(1), "Assigned task", 1, f.observed)
	task.AssignedTo = &member
	facts := taskReadAssigneeFacts(taskReadAssignee(f.principal.UserID, true, nil, nil), taskReadAssignee(member, true, nil, nil), taskReadAssignee(unreferenced, true, nil, nil))
	sync := f.sync(epoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
		if lower != nil {
			t.Fatal("complete delta window changed")
		}
		return []model.TaskViewRecord{task}, nil
	}, facts, 10*time.Second)
	old, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{Epoch: epoch})
	if err != nil || old.Tasks[0].TitlePreview != task.TitlePreview || f.reads != 1 {
		t.Fatalf("task/profile scope: %#v %v", old, err)
	}
	initial := syncAssigneeVersions(t, old)
	name := "Fresh profile"
	freshFacts := taskReadAssigneeFacts(taskReadAssignee(f.principal.UserID, true, nil, nil), taskReadAssignee(member, false, &name, nil))
	after := task
	after.TitlePreview = "Changed in another transaction"
	after.Version++
	sync = f.sync(epoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
		if lower != nil {
			t.Fatal("fresh complete delta changed")
		}
		return []model.TaskViewRecord{after}, nil
	}, freshFacts, 10*time.Second)
	fresh, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{Epoch: epoch})
	if err != nil {
		t.Fatal(err)
	}
	versions := syncAssigneeVersions(t, fresh)
	if versions[member].Version == initial[member].Version || versions[member].HasProjectAccess || versions[unreferenced].UserID != "" || fresh.Tasks[0].TitlePreview == task.TitlePreview || f.reads != 2 {
		t.Fatalf("fresh scope missed profile or Task fields: %#v", fresh)
	}
	if !reflect.DeepEqual(syncAssigneeVersions(t, old), initial) || old.Tasks[0].TitlePreview != task.TitlePreview {
		t.Fatal("fresh scope changed prior response")
	}
}

func TestTaskSyncAssigneeIntegrityFailureReturnsNoSnapshot(t *testing.T) {
	f := newTaskReadFixture(t)
	sync := f.sync(taskReadID(90), func(lower *time.Time) ([]model.TaskViewRecord, error) {
		if lower != nil {
			t.Fatal("integrity snapshot became windowed")
		}
		return []model.TaskViewRecord{}, nil
	}, []model.TaskAssigneeFact{{UserID: taskReadID(20), HasProjectAccess: true, Qualified: true}}, 10*time.Second)
	result, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{})
	assertOperational(t, err)
	if !reflect.DeepEqual(result, model.TaskSync{}) {
		t.Fatalf("missing qualified profile produced partial snapshot: %#v", result)
	}
}
