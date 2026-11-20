package bot

import (
	"context"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type sessionObserver interface {
	ObserveBotSession(context.Context, *store.BotSessionSource) (store.BotSessionLive, error)
}

// WithSessionObserver installs the application's committed Session sampler.
// Configure it during assembly before the service begins serving requests.
func (s *Bots) WithSessionObserver(observer sessionObserver) *Bots {
	s.observer = observer
	return s
}

type observationRead struct {
	bot    model.Bot
	source store.BotObservationSource
	at     time.Time
}

func (s *Bots) readObservation(ctx context.Context, principal model.Principal, id string) (observationRead, error) {
	var out observationRead
	err := s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		out.bot, err = s.operations.get(ctx, scope, principal, id)
		if err != nil {
			return err
		}
		if out.bot.Deletion != nil {
			return &model.Fault{Code: "not_found", Message: "Bot was not found."}
		}
		out.source, err = scope.BotDAO().BotObservation(ctx, principal.UserID, id)
		if err != nil {
			return err
		}
		out.at, err = scope.ObservedAt(ctx)
		return err
	})
	return out, err
}

// Observation reads the current account's Bot without invoking runtime startup,
// renewing a grant, or reusing the Session's original credential as authority.
func (s *Bots) Observation(ctx context.Context, principal model.Principal, id string) (botcore.Observation, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return botcore.Observation{}, err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return botcore.Observation{}, err
	}
	if s.observer == nil {
		return botcore.Observation{}, &model.Fault{Code: "capability_error", Message: "Bot observations are unavailable."}
	}
	before, err := s.readObservation(ctx, principal, id)
	if err != nil {
		return botcore.Observation{}, botcore.ResultError("observe", err)
	}
	live, err := s.observer.ObserveBotSession(ctx, before.source.Session)
	if err != nil {
		// Session admission faults are internal. Publish only this capability's
		// fixed message while retaining the original cause for diagnostics.
		if fault, ok := err.(*model.Fault); ok && fault.Code == "service_unavailable" {
			err = &model.Fault{Code: "capability_error", Message: "Bot observations are unavailable.", Cause: err}
		}
		return botcore.Observation{}, err
	}
	// Live state and PostgreSQL cannot share one snapshot. Reauthorize and read
	// the current lease after sampling; a concurrent takeover or deletion cannot
	// publish activity from the former binding.
	after, err := s.readObservation(ctx, principal, id)
	if err != nil {
		return botcore.Observation{}, botcore.ResultError("observe", err)
	}
	if before.bot.Version != after.bot.Version {
		live.Available = false
	}
	if before.source.Session != nil && after.source.Session != nil && before.source.Session.ServerInstance != after.source.Session.ServerInstance {
		live.Available = false
	}
	if err := ctx.Err(); err != nil {
		return botcore.Observation{}, err
	}
	return botcore.Observe(after.bot, after.source, live, after.at, sessioncore.HeartbeatTimeout), nil
}
