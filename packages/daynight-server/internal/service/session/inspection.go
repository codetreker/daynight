package session

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type InspectionObserver interface {
	InspectTaskSession(context.Context, model.Principal, store.TaskSessionSource) (sp.TaskSessionInspection, error)
}

// Inspection reads an explicit Task Session without advancing lifecycle state.
// A historical Session remains bound to its original execution and owner.
type Inspection struct {
	database    store.SnapshotReader
	observer    InspectionObserver
	authorize   func(context.Context, store.CredentialReader, model.Principal) error
	projectRead func(context.Context, store.ProjectReader, model.Principal, string) error
}

func NewInspection(database store.SnapshotReader, observer InspectionObserver) *Inspection {
	return &Inspection{database: database, observer: observer, authorize: sessioncore.AuthorizeTaskObservation, projectRead: func(ctx context.Context, r store.ProjectReader, p model.Principal, project string) error {
		_, err := projectcore.RequireProjectRead(ctx, r, p, project)
		return err
	}}
}

func (s *Inspection) Inspect(ctx context.Context, p model.Principal, projectID, taskID, sessionID string) (sp.TaskSessionInspection, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return sp.TaskSessionInspection{}, err
	}
	for _, id := range []string{projectID, taskID, sessionID} {
		if _, err := model.CanonicalID(id); err != nil {
			return sp.TaskSessionInspection{}, err
		}
	}
	selected, found, err := s.readSource(ctx, p, projectID, taskID, sessionID)
	if err != nil {
		return sp.TaskSessionInspection{}, fmt.Errorf("select task session inspection: %w", err)
	}
	if !found {
		return sp.TaskSessionInspection{}, &model.Fault{Code: "not_found", Message: "Session was not found.", Cause: model.ErrNotFound}
	}
	// Sampling must not retain the selection snapshot. A new snapshot can then
	// see Task transitions that freeze durable Sessions without changing live cells.
	out, err := s.observer.InspectTaskSession(ctx, p, selected)
	if err != nil {
		return sp.TaskSessionInspection{}, fmt.Errorf("sample task session inspection: %w", err)
	}
	current, found, err := s.readSource(ctx, p, projectID, taskID, sessionID)
	if err != nil {
		return sp.TaskSessionInspection{}, fmt.Errorf("recheck task session inspection: %w", err)
	}
	if !found || !sameInspectionSource(selected, current) {
		out = changedInspection(out)
	}
	return out, nil
}

func (s *Inspection) readSource(ctx context.Context, p model.Principal, projectID, taskID, sessionID string) (store.TaskSessionSource, bool, error) {
	var source store.TaskSessionSource
	found := false
	err := s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorize(ctx, snapshot.CredentialDAO(), p); err != nil {
			return err
		}
		if err := s.projectRead(ctx, snapshot.ProjectDAO(), p, projectID); err != nil {
			return err
		}
		var err error
		source, err = snapshot.SessionDAO().TaskSessionInspectionSource(ctx, projectID, taskID, sessionID)
		if errors.Is(err, model.ErrNotFound) {
			return nil
		}
		found = err == nil
		return err
	})
	if err != nil {
		return store.TaskSessionSource{}, false, err
	}
	return source, found, nil
}

func sameInspectionSource(selected, current store.TaskSessionSource) bool {
	if selected.ProjectID != current.ProjectID || selected.TaskID != current.TaskID || selected.TaskVersion != current.TaskVersion || selected.TaskStatus != current.TaskStatus || !reflect.DeepEqual(selected.Worker, current.Worker) {
		return false
	}
	if selected.Session == nil || current.Session == nil {
		return selected.Session == current.Session
	}
	a, b := *selected.Session, *current.Session
	if a.LastSeen != nil && (b.LastSeen == nil || b.LastSeen.Before(*a.LastSeen)) {
		return false
	}
	// A newer heartbeat or completed archive does not invalidate already sampled
	// facts. Identity, lifecycle and admission evidence must remain identical.
	a.LastSeen, b.LastSeen = nil, nil
	a.ArchiveState, b.ArchiveState = "", ""
	return reflect.DeepEqual(a, b)
}

func changedInspection(out sp.TaskSessionInspection) sp.TaskSessionInspection {
	out.CurrentBinding, out.Source = false, "unavailable"
	out.Session.Observation, out.Session.Reason = "unavailable", "execution_changed"
	out.Session.Activity, out.Session.ConnectionState, out.Session.Lifecycle, out.Session.CurrentTurnID = nil, nil, nil, nil
	out.Session.Indicator, out.Session.NeedsAttention, out.Session.FreshUntil = nil, nil, nil
	out.Session.Send = sp.TaskSessionSend{Reason: "execution_changed"}
	out.Session.Error = &sp.OperationError{Code: "execution_changed", Message: "The selected execution changed before Session inspection completed."}
	return out
}
