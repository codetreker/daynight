package task

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

type mutationDAO struct {
	taskDAO
	current model.Task
	err     error
	action  string
}

func (d *mutationDAO) Task(context.Context, string) (model.Task, error) { return d.current, d.err }
func (d *mutationDAO) CreateTask(_ context.Context, id string, _ store.TaskWrite) (model.Task, error) {
	d.action = "create"
	return model.Task{ID: id}, d.err
}
func (d *mutationDAO) UpdateTask(_ context.Context, id string, _ store.TaskWrite) (model.Task, error) {
	d.action = "update"
	return model.Task{ID: id}, d.err
}
func (d *mutationDAO) DeleteTask(_ context.Context, _ string, _ bool) (model.TaskTombstone, error) {
	d.action = "delete"
	return model.TaskTombstone{}, d.err
}

func TestMutationPreparationAndApply(t *testing.T) {
	ctx := context.Background()
	id := "00000000-0000-4000-8000-000000000001"
	title := "Changed"
	dao := &mutationDAO{current: model.Task{ID: id, Title: "Old", Status: model.TaskTodo, Version: 2, Properties: model.TaskProperties{}}}
	create, err := PrepareCreate(ctx, dao, id, store.TaskWrite{Title: "New"})
	if err != nil || !create.Create {
		t.Fatal(create, err)
	}
	if _, err = ApplyMutation(ctx, dao, create); err != nil || dao.action != "create" {
		t.Fatal(dao.action, err)
	}
	update, err := PrepareUpdate(ctx, dao, id, UpdateTask{Version: 2, Title: &title})
	if err != nil || !update.Changed || update.Values.Title != title {
		t.Fatal(update, err)
	}
	if _, err = ApplyMutation(ctx, dao, update); err != nil || dao.action != "update" {
		t.Fatal(dao.action, err)
	}
	same, err := PrepareUpdate(ctx, dao, id, UpdateTask{Version: 2})
	if err != nil || same.Changed {
		t.Fatal(same, err)
	}
	dao.action = ""
	if _, err = ApplyMutation(ctx, dao, same); err != nil || dao.action != "" {
		t.Fatal(dao.action, err)
	}
	_, err = PrepareUpdate(ctx, dao, id, UpdateTask{Version: 1})
	faultCode(t, err, "version_conflict")
	status, err := PrepareStatus(ctx, dao, model.Principal{}, id, SetTaskStatus{Version: 2, Status: model.TaskInProgress})
	if err != nil || !status.Changed || status.Values.Status != model.TaskInProgress {
		t.Fatal(status, err)
	}
	_, err = PrepareStatus(ctx, dao, model.Principal{}, id, SetTaskStatus{Version: 1, Status: model.TaskDone})
	faultCode(t, err, "version_conflict")
	del, err := PrepareDelete(ctx, dao, dao.current, false)
	if err != nil || !del.Delete {
		t.Fatal(del, err)
	}
	if _, err = ApplyMutation(ctx, dao, del); err != nil || dao.action != "delete" {
		t.Fatal(dao.action, err)
	}
	dao.taskDAO.dependents = []string{"dependent"}
	_, err = PrepareDelete(ctx, dao, dao.current, false)
	faultCode(t, err, "dependency_unsatisfied")
	sentinel := errors.New("read failed")
	dao.err = sentinel
	if _, err = PrepareUpdate(ctx, dao, id, UpdateTask{Version: 2}); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	if _, err = PrepareStatus(ctx, dao, model.Principal{}, id, SetTaskStatus{Version: 2}); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	dao.err = model.ErrNotFound
	_, err = PrepareUpdate(ctx, dao, id, UpdateTask{Version: 2})
	faultCode(t, err, "not_found")
	_, err = PrepareStatus(ctx, dao, model.Principal{}, id, SetTaskStatus{Version: 2})
	faultCode(t, err, "not_found")
}

func TestStatusAndCandidateValidation(t *testing.T) {
	claim := "00000000-0000-4000-8000-000000000002"
	for _, in := range []SetTaskStatus{{}, {Version: 1, Status: "bad"}, {Version: 1, Status: model.TaskTodo, ClaimID: &claim}, {Version: 1, Status: model.TaskDone, ClaimID: ptr("bad")}} {
		if _, err := ValidateStatus(in); err == nil {
			t.Fatalf("accepted %+v", in)
		}
	}
	if _, err := ValidateStatus(SetTaskStatus{Version: 1, Status: model.TaskDone, ClaimID: &claim}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateUpdateFields(UpdateTask{}); err == nil {
		t.Fatal("empty update")
	}
	if err := ValidateUpdateFields(UpdateTask{Title: ptr("x")}); err != nil {
		t.Fatal(err)
	}
	current := model.Task{ID: claim, Title: "Title", Status: model.TaskInProgress, Properties: model.TaskProperties{}}
	faultCode(t, ValidateUpdate(current, store.TaskWrite{AllowAgents: true}), "invalid_transition")
	p := model.PlatformLinux
	faultCode(t, ValidateUpdate(current, store.TaskWrite{RequiredPlatform: &p}), "invalid_transition")
	for _, bad := range []CreateTask{{Title: ""}, {Title: "x", Description: "\x00"}, {Title: "x", RequiredPlatform: ptr(model.TaskPlatform("bad"))}, {Title: "x", AssignedTo: ptr("bad")}, {Title: "x", DependsOn: []string{"bad"}}, {Title: "x", Properties: model.TaskProperties{"worker": []byte("{}")}}} {
		if _, err := CreateCandidate(claim, bad); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	original := model.Task{ID: claim, Title: "Title", Status: model.TaskTodo, Properties: model.TaskProperties{}}
	in := UpdateTask{Title: ptr("New"), Description: ptr("Body"), AllowAgents: ptr(true), RequiredPlatform: ptr(&p), AssignedTo: ptr(ptr(claim)), Properties: model.TaskPropertiesPatch{"paused": []byte("true")}}
	values, err := UpdateCandidate(original, in)
	if err != nil || values.Title != "New" || !Changed(original, values) {
		t.Fatal(values, err)
	}
	if Changed(original, CurrentWrite(original)) {
		t.Fatal("identical task changed")
	}
	bad := "bad"
	if _, err := UpdateCandidate(original, UpdateTask{AssignedTo: ptr(&bad)}); err == nil {
		t.Fatal("bad id")
	}
}
func ptr[T any](v T) *T { return &v }

func TestMutationRefusesInvalidWritesAndIncompatibleWorker(t *testing.T) {
	ctx := context.Background()
	id := "00000000-0000-4000-8000-000000000001"
	dao := &mutationDAO{current: model.Task{ID: id, Title: "Old", Status: model.TaskTodo, Version: 2, Properties: model.TaskProperties{}}}
	_, err := PrepareCreate(ctx, dao, id, store.TaskWrite{DependsOn: []string{"unknown"}})
	faultCode(t, err, "invalid_input")
	active, worker := activeFixture(t)
	worker.AgentControlMode = model.AgentControlModeWeb
	props, err := properties.WithWorker(model.TaskProperties{}, worker)
	if err != nil {
		t.Fatal(err)
	}
	active.Properties = props
	active.Version = 2
	dao.current = active
	if _, err = PrepareUpdate(WithLegacyWorkerProtocol(ctx), dao, id, UpdateTask{Version: 2}); err == nil {
		t.Fatal("legacy update accepted web worker")
	}
	if _, err = PrepareStatus(WithLegacyWorkerProtocol(ctx), dao, model.Principal{}, id, SetTaskStatus{Version: 2, Status: model.TaskDone}); err == nil {
		t.Fatal("legacy status accepted web worker")
	}
	dao.current = model.Task{ID: id, Title: "Old", Status: model.TaskTodo, Version: 2, Properties: model.TaskProperties{}}
	invalid := ""
	if _, err = PrepareUpdate(ctx, dao, id, UpdateTask{Version: 2, Title: &invalid}); err == nil {
		t.Fatal("invalid title")
	}
	blocked := model.Task{ID: id, Title: "Old", Status: model.TaskTodo, Version: 2, Properties: model.TaskProperties{}, BlockedBy: []string{"pre"}}
	dao.current = blocked
	if _, err = PrepareStatus(ctx, dao, model.Principal{}, id, SetTaskStatus{Version: 2, Status: model.TaskDone}); err == nil {
		t.Fatal("blocked status")
	}
	dao.current.Status = model.TaskInProgress
	permission := true
	if _, err = PrepareUpdate(ctx, dao, id, UpdateTask{Version: 2, AllowAgents: &permission}); err == nil {
		t.Fatal("permission changed while active")
	}
}

func TestUpdateCandidateExternalDependencies(t *testing.T) {
	const id = "dd000000-0000-4000-8000-000000000001"
	const a = "aa000000-0000-4000-8000-000000000001"
	const b = "bb000000-0000-4000-8000-000000000001"
	const c = "cc000000-0000-4000-8000-000000000001"
	created, err := CreateCandidate(id, CreateTask{Title: "Target", DependsOn: []string{b, strings.ToUpper(a)}, ExternalDependsOn: []string{strings.ToUpper(b)}})
	if err != nil || !slices.Equal(created.DependsOn, []string{a, b}) || !slices.Equal(created.ExternalDependsOn, []string{b}) {
		t.Fatalf("canonical classified creation: %#v %v", created, err)
	}
	current := model.Task{ID: id, Title: "Target", Status: model.TaskTodo, Version: 7, AllowAgents: true, Properties: model.TaskProperties{}, DependsOn: []string{a, b}, ExternalDependsOn: []string{b}}
	for _, test := range []struct {
		name                   string
		input                  UpdateTask
		dependencies, external []string
		changed                bool
	}{
		{"neither", UpdateTask{Title: ptr("Renamed")}, []string{a, b}, []string{b}, true},
		{"description", UpdateTask{Description: ptr("Preserved classification")}, []string{a, b}, []string{b}, true},
		{"properties", UpdateTask{Properties: model.TaskPropertiesPatch{"pullRequests": []byte(`[{"url":"https://example.com/pr/1","title":"Preserved"}]`)}}, []string{a, b}, []string{b}, true},
		{"dependencies only", UpdateTask{DependsOn: ptr([]string{c, b})}, []string{b, c}, []string{b}, true},
		{"external only", UpdateTask{ExternalDependsOn: ptr([]string{a})}, []string{a, b}, []string{a}, true},
		{"both", UpdateTask{DependsOn: ptr([]string{c}), ExternalDependsOn: ptr([]string{c})}, []string{c}, []string{c}, true},
		{"clear dependencies", UpdateTask{DependsOn: ptr([]string{})}, []string{}, []string{}, true},
		{"clear external", UpdateTask{ExternalDependsOn: ptr([]string{})}, []string{a, b}, []string{}, true},
		{"clear both", UpdateTask{DependsOn: ptr([]string{}), ExternalDependsOn: ptr([]string{})}, []string{}, []string{}, true},
		{"canonical no-op", UpdateTask{DependsOn: ptr([]string{strings.ToUpper(b), a}), ExternalDependsOn: ptr([]string{strings.ToUpper(b)})}, []string{a, b}, []string{b}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := current
			values, err := UpdateCandidate(current, test.input)
			if err != nil || !slices.Equal(values.DependsOn, test.dependencies) || !slices.Equal(values.ExternalDependsOn, test.external) || Changed(current, values) != test.changed || values.AllowAgents != current.AllowAgents || !reflect.DeepEqual(current, before) {
				t.Fatalf("classified candidate: %#v changed=%t want=%t err=%v", values, Changed(current, values), test.changed, err)
			}
		})
	}
	cleared := current
	cleared.DependsOn, cleared.ExternalDependsOn = []string{}, []string{}
	readded, err := UpdateCandidate(cleared, UpdateTask{DependsOn: ptr([]string{b})})
	if err != nil || !slices.Equal(readded.DependsOn, []string{b}) || len(readded.ExternalDependsOn) != 0 {
		t.Fatalf("re-added ordinary dependency restored external history: %#v %v", readded, err)
	}
	for _, input := range []UpdateTask{
		{ExternalDependsOn: ptr([]string{"bad"})},
		{ExternalDependsOn: ptr([]string{a, strings.ToUpper(a)})},
		{ExternalDependsOn: ptr([]string{id})},
		{ExternalDependsOn: ptr([]string{c})},
		{DependsOn: ptr([]string{}), ExternalDependsOn: ptr([]string{a})},
		{DependsOn: ptr([]string{id}), ExternalDependsOn: ptr([]string{id})},
	} {
		_, err := UpdateCandidate(current, input)
		faultCode(t, err, "invalid_input")
	}
	for _, input := range []CreateTask{
		{Title: "Invalid", ExternalDependsOn: []string{a}},
		{Title: "Invalid", DependsOn: []string{a}, ExternalDependsOn: []string{"bad"}},
		{Title: "Invalid", DependsOn: []string{a}, ExternalDependsOn: []string{a, strings.ToUpper(a)}},
		{Title: "Invalid", DependsOn: []string{a}, ExternalDependsOn: []string{b}},
	} {
		_, err := CreateCandidate(id, input)
		faultCode(t, err, "invalid_input")
	}
}
