package task

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
)

type TaskSync struct {
	store   store.SnapshotReader
	engine  SessionStateReader
	overlap time.Duration
}

type SessionStateReader interface {
	TaskSyncSessions(context.Context, model.Principal, []store.TaskSessionSource) (map[string]model.TaskSyncObservation, map[string]model.SessionListState, error)
	TaskSyncObservedAt(context.Context) (time.Time, error)
}

type TaskSyncRequest struct {
	Epoch string
	Since *time.Time
}

func NewTaskSync(database store.SnapshotReader, engine SessionStateReader, overlap time.Duration) *TaskSync {
	return &TaskSync{store: database, engine: engine, overlap: overlap}
}

func syncClockFailure(err error) bool {
	var fault *model.Fault
	return errors.As(err, &fault) && fault.Code == "session_clock_invalid"
}

func syncTimeValid(t time.Time) bool { return !t.IsZero() && t.Year() >= 1 && t.Year() <= 9999 }

func syncBindingEqual(a, b store.TaskSessionSource) bool {
	if !sameObservedBinding(a, b) {
		return false
	}
	if a.Worker != nil && (a.Worker.WorkerID != b.Worker.WorkerID || a.Worker.WorktreeID != b.Worker.WorktreeID || a.Worker.AgentControlMode != b.Worker.AgentControlMode || a.Worker.Agent != b.Worker.Agent) {
		return false
	}
	if a.Session != nil && (a.Session.Backend != b.Session.Backend || a.Session.OwnerID != b.Session.OwnerID || a.Session.ServerInstance != b.Session.ServerInstance || a.Session.ArchiveState != b.Session.ArchiveState || !reflect.DeepEqual(a.Session.TerminalFinalizationID, b.Session.TerminalFinalizationID) || !reflect.DeepEqual(a.Session.Identity, b.Session.Identity)) {
		return false
	}
	return true
}

func validateSyncObservation(v model.TaskSyncObservation, version int64) error {
	if version <= 0 || v.TaskVersion != version {
		return errors.New("invalid session observation task version")
	}
	switch v.State {
	case "no_session", "not_registered", "pending", "working", "notice", "warning", "unavailable":
	default:
		return errors.New("invalid session observation state")
	}
	if v.ObservedAt == nil {
		if v.State != "unavailable" {
			return errors.New("missing session observation time")
		}
	} else if !syncTimeValid(*v.ObservedAt) {
		return errors.New("invalid session observation time")
	}
	if v.FreshUntil != nil && !syncTimeValid(*v.FreshUntil) {
		return errors.New("invalid session freshness time")
	}
	if v.CanOpen && (v.ObservedAt == nil || v.FreshUntil == nil) {
		return errors.New("session opening requires time anchors")
	}
	return nil
}

func (s *TaskSync) Get(ctx context.Context, principal model.Principal, projectID string, input TaskSyncRequest) (model.TaskSync, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.TaskSync{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return model.TaskSync{}, err
	}
	if err := projection.ValidateSync(input.Epoch, input.Since); err != nil {
		return model.TaskSync{}, err
	}
	var result model.TaskSync
	var refusal *model.Fault
	var tasks []store.TaskSyncTaskIdentity
	selected := map[string]store.TaskSessionSource{}
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		result.ActorAccess, err = projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID)
		if err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		result.Project, err = snapshot.ProjectDAO().Project(ctx, projectID)
		if errors.Is(err, model.ErrNotFound) {
			refusal = &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
			return nil
		}
		if err != nil {
			return err
		}
		result, refusal, err = taskcore.ReadSync(ctx, snapshot.TaskDAO(), snapshot.ObservedAt, projectID, input.Epoch, input.Since, s.overlap, result)
		if err != nil || refusal != nil {
			return err
		}
		tasks, err = snapshot.TaskDAO().TaskSyncActiveTasks(ctx, projectID)
		if err != nil {
			return err
		}
		for start := 0; start < len(tasks); start += 200 {
			batch := tasks[start:min(start+200, len(tasks))]
			ids := make([]string, len(batch))
			for i, t := range batch {
				ids[i] = t.ID
			}
			sources, err := snapshot.SessionDAO().TaskSessionSources(ctx, projectID, ids)
			if err != nil {
				return err
			}
			for _, source := range sources {
				selected[source.TaskID] = source
			}
		}
		return nil
	})
	if err != nil {
		return model.TaskSync{}, fmt.Errorf("read task sync: %w", err)
	}
	if refusal != nil {
		return model.TaskSync{}, refusal
	}
	result.TaskObservations = make(map[string]model.TaskSyncObservation, len(tasks))
	result.Sessions = make(map[string]model.SessionListState)
	for start := 0; start < len(tasks); start += 200 {
		batch := tasks[start:min(start+200, len(tasks))]
		sources := make([]store.TaskSessionSource, 0, len(batch))
		for _, t := range batch {
			source, ok := selected[t.ID]
			if !ok || source.ProjectID != projectID || source.TaskVersion != t.Version || source.TaskStatus != model.TaskInProgress {
				result.TaskObservations[t.ID] = model.TaskSyncObservation{TaskVersion: t.Version, State: "unavailable"}
				continue
			}
			sources = append(sources, source)
		}
		observations, sessions, err := s.engine.TaskSyncSessions(ctx, principal, sources)
		if ctx.Err() != nil {
			return model.TaskSync{}, ctx.Err()
		}
		if err != nil && (observationAuthorityFailure(err) || syncClockFailure(err)) {
			return model.TaskSync{}, err
		}
		for _, source := range sources {
			observation, ok := observations[source.TaskID]
			if err != nil || !ok {
				observation = model.TaskSyncObservation{TaskVersion: source.TaskVersion, State: "unavailable"}
			}
			if err := validateSyncObservation(observation, source.TaskVersion); err != nil {
				return model.TaskSync{}, fmt.Errorf("sample task sync: %w", err)
			}
			result.TaskObservations[source.TaskID] = observation
			if value, ok := sessions[source.TaskID]; err == nil && ok {
				result.Sessions[source.TaskID] = value
			}
		}
	}
	// Revalidate every binding in one fresh snapshot after all live sampling.
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		ops := observationDefaults()
		if err := ops.credential(ctx, snapshot.CredentialDAO(), principal); err != nil {
			return err
		}
		if _, err := ops.access(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			return err
		}
		for start := 0; start < len(tasks); start += 200 {
			batch := tasks[start:min(start+200, len(tasks))]
			ids := make([]string, len(batch))
			for i, t := range batch {
				ids[i] = t.ID
			}
			sources, err := snapshot.SessionDAO().TaskSessionSources(ctx, projectID, ids)
			if err != nil {
				return err
			}
			current := make(map[string]store.TaskSessionSource, len(sources))
			for _, source := range sources {
				current[source.TaskID] = source
			}
			for _, t := range batch {
				initial, initialOK := selected[t.ID]
				now, currentOK := current[t.ID]
				if !initialOK || !currentOK || !syncBindingEqual(initial, now) || initial.TaskVersion != t.Version || initial.ProjectID != projectID || initial.TaskStatus != model.TaskInProgress {
					result.TaskObservations[t.ID] = model.TaskSyncObservation{TaskVersion: t.Version, State: "unavailable"}
					delete(result.Sessions, t.ID)
				}
			}
		}
		var err error
		result.ResponseTaskAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if !syncTimeValid(result.ResponseTaskAt) {
			return errors.New("invalid task response time")
		}
		return nil
	})
	if err != nil {
		return model.TaskSync{}, fmt.Errorf("recheck task sync: %w", err)
	}
	result.ResponseSessionAt, err = s.engine.TaskSyncObservedAt(ctx)
	if err != nil {
		return model.TaskSync{}, fmt.Errorf("sample session response time: %w", err)
	}
	if !syncTimeValid(result.ResponseSessionAt) {
		return model.TaskSync{}, errors.New("invalid session response time")
	}
	result.ResponseTaskAt = result.ResponseTaskAt.UTC()
	result.ResponseSessionAt = result.ResponseSessionAt.UTC()
	for _, observation := range result.TaskObservations {
		if observation.State == "unavailable" {
			result.SessionPartial = true
		}
	}
	return result, nil
}
