package task

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

type PersonalTaskItem struct {
	Project          store.PersonalTaskProject
	Task             store.PersonalTaskRow
	MatchedTaskCount int64
	Paused           bool
	Worker           *taskcore.PersonalTaskWorker
	Session          sp.TaskSessionObservation
}

type PersonalTaskPage struct {
	ObservedAt                        time.Time
	InventoryRevision                 string
	TotalTaskCount, TotalProjectCount int64
	SessionPartial                    bool
	Items                             []PersonalTaskItem
	NextCursor                        *string
}

// PersonalTaskError identifies the failed inventory stage without exposing
// underlying storage or observation details in its own message.
type PersonalTaskError struct {
	Phase string
	Cause error
}

func (e *PersonalTaskError) Error() string { return "personal tasks " + e.Phase + " failed" }
func (e *PersonalTaskError) Unwrap() error { return e.Cause }

func personalTaskPhase(phase string, err error) error {
	if err == nil {
		return nil
	}
	return &PersonalTaskError{Phase: phase, Cause: err}
}

// PersonalTasks selects an account inventory in one snapshot, releases it for
// live observation, then checks credentials and the complete inventory again.
func (s *Observations) PersonalTasks(ctx context.Context, principal model.Principal, limit int, cursor *string) (PersonalTaskPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return PersonalTaskPage{}, personalTaskPhase("select", err)
	}
	selection, err := taskcore.SelectPersonalTasks(principal.UserID, limit, cursor)
	if err != nil {
		return PersonalTaskPage{}, personalTaskPhase("select", err)
	}
	result := PersonalTaskPage{Items: []PersonalTaskItem{}}
	var rows store.PersonalTaskPage
	identities := map[string][]executionIdentity{}
	sources := map[string]store.SnapshotScope{}
	projects := map[string]store.PersonalTaskProject{}
	counts := map[string]int64{}
	order := []string{}
	err = s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.operations.credential(ctx, snapshot.CredentialDAO(), principal); err != nil {
			return err
		}
		reader, ok := snapshot.TaskDAO().(store.PersonalTaskReader)
		if !ok {
			return fmt.Errorf("personal task reader is unavailable")
		}
		facts, err := reader.PersonalTaskFacts(ctx, principal.UserID)
		if err != nil {
			return err
		}
		result.InventoryRevision, err = taskcore.PersonalTaskRevision(facts)
		if err != nil {
			return err
		}
		if err := selection.CheckRevision(result.InventoryRevision); err != nil {
			return err
		}
		const maxSafe = int64(1<<53 - 1)
		if int64(len(facts)) > maxSafe {
			return fmt.Errorf("personal task project count exceeds response precision")
		}
		result.TotalProjectCount = int64(len(facts))
		for _, project := range facts {
			count, err := strconv.ParseInt(project.MatchedCount, 10, 64)
			if err != nil || count <= 0 || count > maxSafe-result.TotalTaskCount {
				return fmt.Errorf("personal task count exceeds response precision or is invalid")
			}
			if _, exists := projects[project.ID]; exists {
				return fmt.Errorf("duplicate personal task project")
			}
			projects[project.ID], counts[project.ID] = project, count
			result.TotalTaskCount += count
		}
		rows, err = reader.PersonalTaskPage(ctx, principal.UserID, selection.Query)
		if err != nil {
			return err
		}
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		for _, row := range rows.Items {
			project, exists := projects[row.ProjectID]
			if !exists {
				return fmt.Errorf("personal task row has no project facts")
			}
			paused, err := taskcore.PersonalTaskPaused(row.PausedRaw)
			if err != nil {
				return fmt.Errorf("decode personal task paused: %w", err)
			}
			result.Items = append(result.Items, PersonalTaskItem{Project: project, Task: row, MatchedTaskCount: counts[row.ProjectID], Paused: paused})
			if _, exists := identities[row.ProjectID]; !exists {
				order = append(order, row.ProjectID)
			}
			identities[row.ProjectID] = append(identities[row.ProjectID], executionIdentity{ID: row.ID, Version: row.Version, Type: model.TaskTypeTask})
		}
		if rows.HasMore {
			if len(rows.Items) == 0 {
				return fmt.Errorf("personal task continuation has no position")
			}
			value, err := selection.CursorAfter(result.InventoryRevision, rows.Items[len(rows.Items)-1].Position)
			if err != nil {
				return err
			}
			result.NextCursor = &value
		}
		for _, project := range order {
			selected, err := loadSelectedExecutionSourcesWithPolicy(ctx, snapshot, project, identities[project], true)
			if err != nil {
				return err
			}
			sources[project] = selected
			ids := make([]string, len(identities[project]))
			for i, identity := range identities[project] {
				ids[i] = identity.ID
			}
			captured, err := selected.SessionDAO().TaskSessionSources(ctx, project, ids)
			if err != nil {
				return err
			}
			byID := make(map[string]store.TaskSessionSource, len(captured))
			for _, source := range captured {
				byID[source.TaskID] = source
			}
			for i := range result.Items {
				item := &result.Items[i]
				if item.Task.ProjectID != project {
					continue
				}
				source, exists := byID[item.Task.ID]
				if !exists || source.TaskID != item.Task.ID || source.ProjectID != project || source.TaskVersion != item.Task.Version || source.TaskStatus != model.TaskInProgress {
					return fmt.Errorf("personal task source does not match selected row")
				}
				item.Worker = taskcore.ActivePersonalTaskWorker(source.Worker)
			}
		}
		return nil
	})
	if err != nil {
		return PersonalTaskPage{}, personalTaskPhase("select", err)
	}
	allObservations := map[string]sp.TaskSessionObservation{}
	for _, project := range order {
		observations, partial, observeErr := s.observeExecutionBatchWithPolicy(ctx, sources[project], principal, project, identities[project], result.ObservedAt, true)
		if observeErr != nil {
			var stage *PersonalTaskError
			if !errors.As(observeErr, &stage) {
				observeErr = personalTaskPhase("observe", observeErr)
			}
			if ctx.Err() != nil {
				return PersonalTaskPage{}, observeErr
			}
			// An access refusal may reflect a changed inventory. Credential errors
			// retain their own result; changed project access becomes reset_required.
			// Storage errors are returned directly without a second attempt.
			if _, known := operation.KnownFault(observeErr); known && observationAuthorityFailure(observeErr) {
				if err := s.recheckPersonalInventory(ctx, principal, result.InventoryRevision); err != nil {
					return PersonalTaskPage{}, err
				}
			}
			return PersonalTaskPage{}, observeErr
		}
		result.SessionPartial = result.SessionPartial || partial
		for id, observation := range observations {
			allObservations[id] = observation
		}
	}
	if err := s.recheckPersonalInventory(ctx, principal, result.InventoryRevision); err != nil {
		return PersonalTaskPage{}, err
	}
	if err := ctx.Err(); err != nil {
		return PersonalTaskPage{}, personalTaskPhase("recheck", err)
	}
	for i := range result.Items {
		result.Items[i].Session = allObservations[result.Items[i].Task.ID]
	}
	return result, nil
}

func (s *Observations) recheckPersonalInventory(ctx context.Context, principal model.Principal, expected string) error {
	err := s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.operations.credential(ctx, snapshot.CredentialDAO(), principal); err != nil {
			return err
		}
		reader, ok := snapshot.TaskDAO().(store.PersonalTaskReader)
		if !ok {
			return fmt.Errorf("personal task reader is unavailable")
		}
		facts, err := reader.PersonalTaskFacts(ctx, principal.UserID)
		if err != nil {
			return err
		}
		revision, err := taskcore.PersonalTaskRevision(facts)
		if err != nil {
			return err
		}
		if revision != expected {
			return &model.Fault{Code: "reset_required", Message: "Tasks changed during this personal inventory; restart the inventory."}
		}
		return nil
	})
	return personalTaskPhase("recheck", err)
}
