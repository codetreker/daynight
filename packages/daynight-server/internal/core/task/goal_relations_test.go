package task

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const relationProject = "11111111-1111-4111-8111-111111111111"
const relationGoal = "22222222-2222-4222-8222-222222222222"
const relationUpstream = "33333333-3333-4333-8333-333333333333"
const relationEdge = "44444444-4444-4444-8444-444444444444"

type relationPolicyDAO struct {
	store.GoalRelationEditor
	edges                 []store.GoalRelationEdge
	edgesErr, errorReach  error
	cycle                 bool
	edgeCalls, reachCalls int
}

func (d *relationPolicyDAO) Edges(context.Context, string) ([]store.GoalRelationEdge, error) {
	d.edgeCalls++
	return d.edges, d.edgesErr
}
func (d *relationPolicyDAO) Reaches(_ context.Context, project, goal, target string, removed []string) (bool, error) {
	d.reachCalls++
	return d.cycle, d.errorReach
}
func relationFacts() store.GoalRelationAdmission {
	return store.GoalRelationAdmission{Source: store.GoalRelationSource{Type: model.TaskTypeGoal, Status: model.TaskTodo, CanRead: true, CanEdit: true, TeamID: relationProject, Revision: 1}, Targets: []store.GoalRelationCandidate{{Endpoint: store.GoalEndpoint{ProjectID: relationProject, GoalID: relationUpstream}, Available: true, TeamID: relationProject, Status: model.TaskTodo}}}
}
func relationAdd() GoalDependencyEdit {
	return GoalDependencyEdit{IfRevision: 1, Mode: "edit", Add: []GoalDependencyEndpoint{{ProjectID: relationProject, GoalID: relationUpstream}}}
}
func relationCode(err error) string {
	var fault *model.Fault
	if errors.As(err, &fault) {
		return fault.Code
	}
	return ""
}

func TestGoalRelationPolicyAdmission(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(*store.GoalRelationAdmission, *relationPolicyDAO, *GoalDependencyEdit)
	}{
		{"denied source", "not_found", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Source.CanRead = false
		}},
		{"read only source", "not_found", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Source.CanEdit = false
		}},
		{"deleted source", "task_deleted", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Source.Deleted = true
		}},
		{"missing source", "not_found", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) { f.Source.Type = "" }},
		{"ordinary source", "invalid_input", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Source.Type = model.TaskTypeTask
		}},
		{"stale revision", "goal_dependency_revision_conflict", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Source.Revision = 2
		}},
		{"hidden target", "goal_dependency_target_unavailable", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Targets[0].Available = false
		}},
		{"other Team", "goal_dependency_team_mismatch", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Targets[0].TeamID = relationGoal
		}},
		{"self reference", "invalid_input", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Targets[0].Endpoint.GoalID = relationGoal
		}},
		{"cycle", "goal_dependency_cycle", func(_ *store.GoalRelationAdmission, d *relationPolicyDAO, _ *GoalDependencyEdit) { d.cycle = true }},
		{"done source", "goal_dependency_unsatisfied", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, _ *GoalDependencyEdit) {
			f.Source.Status = model.TaskDone
		}},
		{"exhaustion", "version_exhausted", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, i *GoalDependencyEdit) {
			f.Source.Revision = math.MaxInt64
			i.IfRevision = math.MaxInt64
		}},
		{"unknown remove", "invalid_input", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, i *GoalDependencyEdit) {
			f.Targets = nil
			i.Add = nil
			i.Remove = []string{relationEdge}
		}},
		{"unknown retain", "invalid_input", func(f *store.GoalRelationAdmission, _ *relationPolicyDAO, i *GoalDependencyEdit) {
			f.Targets = nil
			*i = GoalDependencyEdit{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{EdgeID: relationEdge}}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := relationFacts()
			d := &relationPolicyDAO{}
			i := relationAdd()
			test.change(&f, d, &i)
			_, changed, err := PrepareGoalRelations(t.Context(), d, relationGoal, i, f)
			if relationCode(err) != test.code || changed {
				t.Fatalf("changed=%v error=%v", changed, err)
			}
			if test.name == "stale revision" && d.edgeCalls != 0 {
				t.Fatal("stale revision read edges")
			}
		})
	}
}

func TestGoalRelationPolicyRetainsIdentitiesAndClears(t *testing.T) {
	edge := store.GoalRelationEdge{ID: relationEdge, Endpoint: store.GoalEndpoint{ProjectID: relationProject, GoalID: relationUpstream}, Status: model.TaskDone}
	for _, mode := range []string{"add", "retain", "replace endpoint", "clear", "remove"} {
		t.Run(mode, func(t *testing.T) {
			f := relationFacts()
			f.Targets[0].Status = model.TaskDone
			f.Source.Status = model.TaskDone
			d := &relationPolicyDAO{edges: []store.GoalRelationEdge{edge}}
			input := relationAdd()
			wantChanged := false
			switch mode {
			case "retain":
				f.Targets = nil
				input = GoalDependencyEdit{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{EdgeID: relationEdge}}}
			case "replace endpoint":
				input = GoalDependencyEdit{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{ProjectID: relationProject, GoalID: relationUpstream}}}
			case "clear":
				f.Targets = nil
				input = GoalDependencyEdit{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{}}
				wantChanged = true
			case "remove":
				f.Targets = nil
				input = GoalDependencyEdit{IfRevision: 1, Mode: "edit", Remove: []string{relationEdge}}
				wantChanged = true
			}
			result, changed, err := PrepareGoalRelations(t.Context(), d, relationGoal, input, f)
			if err != nil || changed != wantChanged {
				t.Fatalf("result=%+v changed=%v err=%v", result, changed, err)
			}
			if !changed && (len(result) != 1 || result[0].ID != relationEdge) {
				t.Fatalf("identity lost: %+v", result)
			}
			if d.reachCalls != 0 {
				t.Fatal("unchanged endpoint ran reachability")
			}
		})
	}
	for _, failure := range []string{"edges", "reach"} {
		t.Run(failure, func(t *testing.T) {
			sentinel := errors.New("storage failed")
			d := &relationPolicyDAO{}
			if failure == "edges" {
				d.edgesErr = sentinel
			} else {
				d.errorReach = sentinel
			}
			_, _, err := PrepareGoalRelations(t.Context(), d, relationGoal, relationAdd(), relationFacts())
			if !errors.Is(err, sentinel) {
				t.Fatalf("lost error: %v", err)
			}
		})
	}
}

func TestGoalRelationValidation(t *testing.T) {
	valid := []GoalDependencyEdit{relationAdd(), {IfRevision: 1, Mode: "edit", Remove: []string{relationEdge}}, {IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{}}, {IfRevision: math.MaxInt64, Mode: "replace", Prerequisites: []GoalDependencyReference{{EdgeID: relationEdge}, {ProjectID: relationProject, GoalID: relationUpstream}}}}
	for _, input := range valid {
		if err := ValidateGoalDependencyEdit(input); err != nil {
			t.Fatalf("valid %+v: %v", input, err)
		}
	}
	for _, input := range []GoalDependencyEdit{
		{}, {IfRevision: 0, Mode: "edit"}, {IfRevision: 1, Mode: "unknown"}, {IfRevision: 1, Mode: "edit"}, {IfRevision: 1, Mode: "replace"},
		{IfRevision: 1, Mode: "edit", Add: []GoalDependencyEndpoint{{ProjectID: "bad", GoalID: relationGoal}}},
		{IfRevision: 1, Mode: "edit", Remove: []string{"bad"}},
		{IfRevision: 1, Mode: "edit", Remove: []string{relationEdge, relationEdge}},
		{IfRevision: 1, Mode: "edit", Add: []GoalDependencyEndpoint{{ProjectID: relationProject, GoalID: relationGoal}, {ProjectID: relationProject, GoalID: relationGoal}}},
		{IfRevision: 1, Mode: "replace", Add: []GoalDependencyEndpoint{}, Prerequisites: []GoalDependencyReference{}},
		{IfRevision: 1, Mode: "edit", Remove: []string{relationEdge}, Prerequisites: []GoalDependencyReference{}},
		{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{EdgeID: relationEdge, GoalID: relationGoal}}},
		{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{EdgeID: "bad"}}},
		{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{}}},
		{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{EdgeID: relationEdge}, {EdgeID: relationEdge}}},
		{IfRevision: 1, Mode: "replace", Prerequisites: []GoalDependencyReference{{ProjectID: relationProject, GoalID: relationGoal}, {ProjectID: relationProject, GoalID: relationGoal}}},
		{IfRevision: 1, Mode: "edit", Remove: make([]string, 31)},
	} {
		if err := ValidateGoalDependencyEdit(input); relationCode(err) != "invalid_input" {
			t.Fatalf("invalid %+v: %v", input, err)
		}
	}
}
