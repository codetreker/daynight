package task

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type inputValidationDAO struct {
	store.TaskWriteDAO
	readTask     func(context.Context, string) (model.Task, error)
	dependencies func(context.Context, []string) ([]model.Task, error)
}

func (dao inputValidationDAO) Task(ctx context.Context, id string) (model.Task, error) {
	if dao.readTask == nil {
		panic("unexpected Task read during candidate preparation")
	}
	return dao.readTask(ctx, id)
}

func (dao inputValidationDAO) TasksByID(ctx context.Context, ids []string) ([]model.Task, error) {
	if dao.dependencies == nil {
		panic("unexpected dependency read during candidate preparation")
	}
	return dao.dependencies(ctx, ids)
}

func (inputValidationDAO) CreateTask(context.Context, string, store.TaskWrite) (model.Task, error) {
	panic("candidate preparation unexpectedly created a Task")
}

func (inputValidationDAO) UpdateTask(context.Context, string, store.TaskWrite) (model.Task, error) {
	panic("candidate preparation unexpectedly updated a Task")
}

func (inputValidationDAO) DeleteTask(context.Context, string, bool) (model.TaskTombstone, error) {
	panic("candidate preparation unexpectedly deleted a Task")
}

func inputValidationTask() model.Task {
	now := time.Date(2026, time.November, 6, 0, 0, 0, 0, time.UTC)
	return model.Task{ID: "a0000000-0000-4000-8000-000000000003", ProjectID: "b0000000-0000-4000-8000-000000000004",
		Title: "Target", Status: model.TaskTodo, Version: 1, Properties: model.TaskProperties{},
		DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: now, UpdatedAt: now}
}

func TestPrepareUpdateRejectsInvalidCandidateValues(t *testing.T) {
	for _, test := range []struct {
		name  string
		input func(model.Task) UpdateTask
	}{
		{"blank title", func(current model.Task) UpdateTask { return UpdateTask{Version: current.Version, Title: ptr(" ")} }},
		{"NUL description", func(current model.Task) UpdateTask {
			return UpdateTask{Version: current.Version, Description: ptr("bad\x00")}
		}},
		{"invalid dependency identity", func(current model.Task) UpdateTask {
			return UpdateTask{Version: current.Version, DependsOn: ptr([]string{"invalid"})}
		}},
		{"self dependency", func(current model.Task) UpdateTask {
			return UpdateTask{Version: current.Version, DependsOn: ptr([]string{current.ID})}
		}},
		{"case normalized self dependencies", func(current model.Task) UpdateTask {
			return UpdateTask{Version: current.Version, DependsOn: ptr([]string{current.ID, strings.ToUpper(current.ID)})}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			current := inputValidationTask()
			calls := 0
			dao := inputValidationDAO{readTask: func(actual context.Context, id string) (model.Task, error) {
				calls++
				if actual != ctx || id != current.ID {
					t.Fatalf("candidate lookup changed context or Task identity: %q", id)
				}
				return current, nil
			}}
			_, err := PrepareUpdate(ctx, dao, current.ID, test.input(current))
			faultCode(t, err, "invalid_input")
			if calls != 1 || !reflect.DeepEqual(current, inputValidationTask()) {
				t.Fatalf("invalid candidate changed its read count or stored resource: calls=%d current=%+v", calls, current)
			}
		})
	}
}

func TestMutationPreparationPreservesReadAndVersionOrder(t *testing.T) {
	sentinel := errors.New("Task lookup unavailable")
	principal := model.Principal{Kind: model.SessionCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}
	for _, method := range []string{"update", "status"} {
		t.Run(method, func(t *testing.T) {
			for _, scenario := range []string{"valid change", "stale version", "missing Task", "operational failure"} {
				t.Run(scenario, func(t *testing.T) {
					ctx := t.Context()
					current := inputValidationTask()
					var lookupErr error
					switch scenario {
					case "missing Task":
						lookupErr = model.ErrNotFound
					case "operational failure":
						lookupErr = fmt.Errorf("load Task: %w", sentinel)
					}
					reads, dependencyReads := 0, 0
					dao := inputValidationDAO{readTask: func(actual context.Context, id string) (model.Task, error) {
						reads++
						if actual != ctx || id != current.ID {
							t.Fatalf("preparation lookup changed context or Task identity: %q", id)
						}
						if lookupErr != nil {
							return model.Task{}, lookupErr
						}
						return current, nil
					}}
					if scenario == "valid change" && method == "update" {
						dao.dependencies = func(actual context.Context, ids []string) ([]model.Task, error) {
							dependencyReads++
							if actual != ctx || len(ids) != 0 {
								t.Fatalf("empty dependency lookup changed context or identifiers: %v", ids)
							}
							return []model.Task{}, nil
						}
					}
					version := current.Version
					title := "Changed"
					status := model.TaskInProgress
					if scenario == "stale version" {
						version++
						title, status = " ", current.Status
					}
					var mutation Mutation
					var err error
					if method == "update" {
						mutation, err = PrepareUpdate(ctx, dao, current.ID, UpdateTask{Version: version, Title: &title})
					} else {
						mutation, err = PrepareStatus(ctx, dao, principal, current.ID, SetTaskStatus{Version: version, Status: status})
					}
					switch scenario {
					case "valid change":
						if err != nil || !mutation.Changed || mutation.ID != current.ID || !reflect.DeepEqual(mutation.Current, current) || method == "update" && mutation.Values.Title != title || method == "status" && mutation.Values.Status != status {
							t.Fatalf("valid candidate was not prepared: %+v %v", mutation, err)
						}
					case "stale version":
						faultCode(t, err, "version_conflict")
					case "missing Task":
						faultCode(t, err, "not_found")
						if !errors.Is(err, model.ErrNotFound) {
							t.Fatalf("missing Task cause lost: %v", err)
						}
					case "operational failure":
						var refusal *model.Fault
						if !errors.Is(err, lookupErr) || !errors.Is(err, sentinel) || errors.As(err, &refusal) {
							t.Fatalf("Task lookup lost its operational error chain: %v", err)
						}
					}
					wantDependencies := 0
					if scenario == "valid change" && method == "update" {
						wantDependencies = 1
					}
					if reads != 1 || dependencyReads != wantDependencies || !reflect.DeepEqual(current, inputValidationTask()) {
						t.Fatalf("preparation changed its reads or stored resource: Task=%d dependencies=%d current=%+v", reads, dependencyReads, current)
					}
				})
			}
		})
	}
	t.Run("current version same status", func(t *testing.T) {
		ctx := t.Context()
		current := inputValidationTask()
		reads := 0
		dao := inputValidationDAO{readTask: func(actual context.Context, id string) (model.Task, error) {
			reads++
			if actual != ctx || id != current.ID {
				t.Fatalf("same-status lookup changed context or Task identity: %q", id)
			}
			return current, nil
		}}
		mutation, err := PrepareStatus(ctx, dao, principal, current.ID, SetTaskStatus{Version: current.Version, Status: current.Status})
		if err != nil || mutation.Changed || reads != 1 || !reflect.DeepEqual(mutation.Current, current) {
			t.Fatalf("same-status candidate changed its current resource: %+v reads=%d error=%v", mutation, reads, err)
		}
	})
}
