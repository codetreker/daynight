package postgres

import (
	"encoding/json"
	"errors"
	"math/big"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func searchMutationFence(t *testing.T, database *Store, projectID string) store.TaskSearchFence {
	t.Helper()
	var fence store.TaskSearchFence
	if err := NewTaskSearch(database.Pool).ReadTaskSearch(t.Context(), func(snapshot store.TaskSearchSnapshot) error {
		var err error
		fence, err = snapshot.Fence(t.Context(), projectID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return fence
}

func searchFenceIncrement(t *testing.T, number string) string {
	t.Helper()
	value, valid := new(big.Int).SetString(number, 10)
	if !valid {
		t.Fatalf("invalid decimal fence value %q", number)
	}
	return value.Add(value, big.NewInt(1)).String()
}

func TestTaskSearchFenceTracksCommittedDAOMutations(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 11, model.TaskTodo)
	predecessor := queryTask(t, database, project.ID, 12, model.TaskTodo)
	ctx := t.Context()
	initial := searchMutationFence(t, database, project.ID)
	if initial.Count != "2" || initial.VersionSum != "2" || initial.Epoch == "" {
		t.Fatalf("unexpected initial fence: %+v", initial)
	}

	check := func(t *testing.T, creates, replacesEpoch bool, operation func(store.ProjectWriteScope) error) {
		t.Helper()
		before := searchMutationFence(t, database, project.ID)
		completion, err := database.WriteProject(ctx, project.ID, operation)
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("DAO mutation did not commit: %+v %v", completion, err)
		}
		after := searchMutationFence(t, database, project.ID)
		expected := before
		if replacesEpoch {
			if after.Epoch == before.Epoch || after.Epoch == "" {
				t.Fatalf("cache invalidation retained epoch: %+v -> %+v", before, after)
			}
			expected.Epoch = after.Epoch
		} else {
			expected.VersionSum = searchFenceIncrement(t, before.VersionSum)
			if creates {
				expected.Count = searchFenceIncrement(t, before.Count)
			}
		}
		if after != expected {
			t.Fatalf("committed DAO fence: got %+v, want %+v (before %+v)", after, expected, before)
		}
	}

	t.Run("create", func(t *testing.T) {
		check(t, true, false, func(scope store.ProjectWriteScope) error {
			_, err := scope.TaskDAO().CreateTask(ctx, queryID(13), store.TaskWrite{Title: "New", Status: model.TaskTodo})
			return err
		})
	})

	for _, mutation := range []struct {
		name   string
		values func(*store.TaskWrite)
	}{
		{"title", func(values *store.TaskWrite) { values.Title = "Changed title" }},
		{"description", func(values *store.TaskWrite) { values.Description = "Changed description" }},
		{"assignment", func(values *store.TaskWrite) { assignee := queryID(20); values.AssignedTo = &assignee }},
		{"platform", func(values *store.TaskWrite) { platform := model.PlatformLinux; values.RequiredPlatform = &platform }},
		{"agent permission", func(values *store.TaskWrite) { values.AllowAgents = true }},
		{"dependency", func(values *store.TaskWrite) { values.DependsOn = []string{predecessor.ID} }},
		{"property", func(values *store.TaskWrite) {
			values.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}
		}},
		{"status", func(values *store.TaskWrite) { values.Status = model.TaskInProgress }},
		{"worker claim", func(values *store.TaskWrite) {
			values.Properties = fixtureTaskProperties(t, workerWitnessClaim(11, queryID(20), queryID(21), model.WorkerActive))
		}},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			before := target
			values := taskMutationValues(target)
			mutation.values(&values)
			check(t, false, false, func(scope store.ProjectWriteScope) error {
				var err error
				target, err = scope.TaskDAO().UpdateTask(ctx, target.ID, values)
				return err
			})
			stored := snapshotTask(t, database, project.ID, target.ID)
			if target.Version != before.Version+1 || !reflect.DeepEqual(stored, target) || !reflect.DeepEqual(taskMutationValues(stored), values) {
				t.Fatalf("mutation result did not match persistent version: %+v %+v", target, stored)
			}
		})
	}

	t.Run("step parent revision", func(t *testing.T) {
		check(t, false, false, func(scope store.ProjectWriteScope) error {
			dao := scope.TaskDAO()
			observed, err := dao.ObservedAt(ctx)
			if err != nil {
				return err
			}
			if err := dao.InsertTaskStep(ctx, target.ID, model.TaskStep{ID: "abcdef01", Position: 0, Title: "Step", Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed}); err != nil {
				return err
			}
			return dao.TouchTask(ctx, target.ID, observed)
		})
		target = snapshotTask(t, database, project.ID, target.ID)
	})

	t.Run("soft deletion retains row in fence", func(t *testing.T) {
		check(t, false, false, func(scope store.ProjectWriteScope) error {
			_, err := scope.TaskDAO().DeleteTask(ctx, queryID(13), false)
			return err
		})
	})

	t.Run("history epoch replacement", func(t *testing.T) {
		check(t, false, true, func(scope store.ProjectWriteScope) error {
			return scope.ProjectDAO().InvalidateTaskCache(ctx)
		})
	})

	t.Run("read-only and rollback retain fence", func(t *testing.T) {
		before := searchMutationFence(t, database, project.ID)
		read := snapshotTask(t, database, project.ID, target.ID)
		if !reflect.DeepEqual(read, target) || searchMutationFence(t, database, project.ID) != before {
			t.Fatal("read-only snapshot changed the fence")
		}
		refusal := errors.New("rollback sentinel")
		completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			values := taskMutationValues(target)
			values.Title = "Must roll back"
			if _, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values); err != nil {
				return err
			}
			return refusal
		})
		if !errors.Is(err, refusal) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("rollback outcome: %+v %v", completion, err)
		}
		if searchMutationFence(t, database, project.ID) != before || !reflect.DeepEqual(snapshotTask(t, database, project.ID, target.ID), target) {
			t.Fatal("rolled-back update changed persistent task or fence")
		}
	})
}
