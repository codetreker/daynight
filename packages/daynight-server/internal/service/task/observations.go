package task

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
)

type SessionObserver interface {
	ObserveTaskSessions(context.Context, model.Principal, []store.TaskSessionSource) (map[string]sp.TaskSessionObservation, error)
}
type Observations struct {
	database   store.SnapshotReader
	observer   SessionObserver
	operations observationOperations
}

func NewObservations(database store.SnapshotReader, observer SessionObserver) *Observations {
	return &Observations{database: database, observer: observer, operations: observationDefaults()}
}

type ObservedTask struct {
	Task    model.Task
	Session sp.TaskSessionObservation
	Epoch   string
}
type ObservedTaskPage struct {
	Items      []ObservedTask
	NextCursor *string
	ObservedAt time.Time
	Partial    bool
}
type ObservedGraph struct {
	Graph       model.TaskGraph
	Sessions    map[string]sp.TaskSessionObservation
	Relations   map[string]string
	Aggregation taskwork.Aggregation
	ObservedAt  time.Time
	Partial     bool
}
type ObservedMCPItem struct {
	Item    store.TaskPriorityItem
	Session sp.TaskSessionObservation
}
type ObservedMCPPage struct {
	Items      []ObservedMCPItem
	NextCursor *string
	ObservedAt time.Time
	Partial    bool
}

func observationIdentity(principal model.Principal, projectID string) (string, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return "", err
	}
	return model.CanonicalID(projectID)
}
func (s *Observations) authorizeObservation(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, projectID string) error {
	if err := s.operations.credential(ctx, snapshot.CredentialDAO(), principal); err != nil {
		return err
	}
	_, err := s.operations.access(ctx, snapshot.ProjectDAO(), principal, projectID)
	return err
}
func observationAuthorityFailure(err error) bool {
	var fault *model.Fault
	if !errors.As(err, &fault) {
		return false
	}
	switch fault.Code {
	case "unauthenticated", "unauthorized", "forbidden", "not_found", "project_deleted", "invalid_credentials", "credential_expired", "credential_revoked":
		return true
	}
	return false
}
func unavailableObservation(observed time.Time, reason string) sp.TaskSessionObservation {
	return sp.TaskSessionObservation{SchemaVersion: 1, Observation: "unavailable", Registration: "unknown", Reason: reason, Send: sp.TaskSessionSend{Reason: reason}, ObservedAt: &observed, Error: &sp.OperationError{Code: reason, Message: "Session observation is unavailable; query this task again."}}
}

func goalObservation(observed time.Time) sp.TaskSessionObservation {
	allowed := false
	freshUntil := observed.Add(sessioncore.HeartbeatTimeout)
	return sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "not_applicable", Reason: "no_execution", Send: sp.TaskSessionSend{Allowed: &allowed, Reason: "no_execution"}, ObservedAt: &observed, FreshUntil: &freshUntil}
}

// observeBatch retains each selected Task even when observation fails. Sources
// are read from the same authorized snapshot and are never substituted by a
// later Task execution. Live facts remain separately fenced by the observer.
func (s *Observations) observeBatch(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, projectID string, tasks []model.Task, observed time.Time) (map[string]sp.TaskSessionObservation, bool, error) {
	return s.observeExecutionBatch(ctx, snapshot, principal, projectID, taskExecutionIdentities(tasks), observed)
}

func (s *Observations) observeExecutionBatch(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, projectID string, tasks []executionIdentity, observed time.Time) (map[string]sp.TaskSessionObservation, bool, error) {
	return s.observeExecutionBatchWithPolicy(ctx, snapshot, principal, projectID, tasks, observed, false)
}

func (s *Observations) observeExecutionBatchWithPolicy(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, projectID string, tasks []executionIdentity, observed time.Time, strictSourceErrors bool) (map[string]sp.TaskSessionObservation, bool, error) {
	result := make(map[string]sp.TaskSessionObservation, len(tasks))
	partial := false
	for _, task := range tasks {
		if task.Type == model.TaskTypeGoal {
			result[task.ID] = goalObservation(observed)
		}
	}
	tasks = observableExecutionTasks(tasks)
	for start := 0; start < len(tasks); start += 200 {
		end := min(start+200, len(tasks))
		batch := tasks[start:end]
		ids := make([]string, len(batch))
		selected := make(map[string]executionIdentity, len(batch))
		for i, t := range batch {
			ids[i] = t.ID
			selected[t.ID] = t
		}
		sources, err := snapshot.SessionDAO().TaskSessionSources(ctx, projectID, ids)
		if err != nil {
			if strictSourceErrors || observationAuthorityFailure(err) || ctx.Err() != nil {
				return nil, false, err
			}
			partial = true
			for _, task := range batch {
				result[task.ID] = unavailableObservation(observed, "observation_unavailable")
			}
			continue
		}
		matched := make([]store.TaskSessionSource, 0, len(sources))
		for _, source := range sources {
			task, exists := selected[source.TaskID]
			if !exists {
				continue
			}
			changed := source.ProjectID != projectID || source.TaskVersion != task.Version
			if len(task.Worker) > 0 {
				worker, decodeErr := taskproperty.Worker(model.TaskProperties{"worker": task.Worker})
				if decodeErr != nil {
					changed = true
				} else if (worker == nil) != (source.Worker == nil) || worker != nil && source.Worker != nil && worker.ClaimID != source.Worker.ClaimID {
					changed = true
				}
			}
			if changed {
				partial = true
				result[task.ID] = unavailableObservation(observed, "execution_changed")
				continue
			}
			matched = append(matched, source)
		}
		observations, err := s.observer.ObserveTaskSessions(ctx, principal, matched)
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		if err != nil {
			if observationAuthorityFailure(err) || ctx.Err() != nil {
				return nil, false, err
			}
			partial = true
		}
		current, recheckErr := s.recheckSources(ctx, principal, projectID, ids)
		if recheckErr != nil && (strictSourceErrors || observationAuthorityFailure(recheckErr) || ctx.Err() != nil) {
			if strictSourceErrors {
				return nil, false, personalTaskPhase("recheck", recheckErr)
			}
			return nil, false, recheckErr
		}
		original := make(map[string]store.TaskSessionSource, len(sources))
		for _, source := range sources {
			original[source.TaskID] = source
		}
		for _, task := range batch {
			if _, exists := result[task.ID]; exists {
				continue
			}
			observation, exists := observations[task.ID]
			source, currentExists := current[task.ID]
			initial, initialExists := original[task.ID]
			if strictSourceErrors && recheckErr == nil && (!currentExists || !initialExists || !samePersonalTaskBinding(initial, source)) {
				return nil, false, personalTaskPhase("recheck", &model.Fault{Code: "reset_required", Message: "Tasks changed during this personal inventory; restart the inventory."})
			}
			if recheckErr == nil && (!currentExists || !initialExists || !sameObservedBinding(initial, source)) {
				result[task.ID] = unavailableObservation(observed, "execution_changed")
				partial = true
				continue
			}
			if err != nil || recheckErr != nil || !exists {
				observation = unavailableObservation(observed, "observation_unavailable")
			}
			partial = partial || observation.Observation != "observed"
			result[task.ID] = observation
		}
	}
	return result, partial, nil
}
