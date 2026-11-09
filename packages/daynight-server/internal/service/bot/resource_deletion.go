package bot

import (
	"context"
	"errors"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type resourceCleanupFailure struct{ cause error }

func (e *resourceCleanupFailure) Error() string { return e.cause.Error() }
func (e *resourceCleanupFailure) Unwrap() error { return e.cause }

// cleanSessionResources commits the deletion epoch before waiting for I/O. It
// retains rows and files after an uncertain transaction instead of inferring
// rollback or a successful stop from lease age.
func (s *Deletions) cleanSessionResources(ctx context.Context, p model.Principal, id, deletionID string, live interface {
	CancelSessionMedia(context.Context, string) error
}) error {
	var sessions []store.BotSession
	completion, err := s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
		bot, e := s.lockBot(ctx, scope, p, id)
		if e != nil {
			return e
		}
		change, e := botcore.PrepareServerCleanup(bot, deletionID)
		if e != nil || !change {
			return e
		}
		sessions, e = scope.SessionDAO().LockBotSessions(ctx, id)
		if e != nil {
			return e
		}
		media, ok := scope.SessionDAO().(store.SessionResourceDAO)
		if !ok {
			return deletionFault("component_unsupported", "Resource deletion requires a server upgrade.")
		}
		for _, session := range sessions {
			if session.Owner != bot.OwnerUserID || session.Scope != "test" || session.Backend != "web" {
				return deletionConflict()
			}
			if _, e = media.SessionResourceUsage(ctx, session.ID); e != nil {
				return e
			}
			if _, e = media.BeginSessionResourceDeletion(ctx, session.ID); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("resource deletion admission closure was not confirmed")
	}
	storage, ok := s.files.(filestorage.ResourceStorage)
	if !ok && len(sessions) > 0 {
		return &resourceCleanupFailure{deletionFault("component_unsupported", "Typed resource cleanup is unavailable.")}
	}
	for _, session := range sessions {
		if err = live.CancelSessionMedia(ctx, session.ID); err != nil {
			return &resourceCleanupFailure{err}
		}
		var leases []store.SessionResourceLease
		completion, err = s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
			var e error
			leases, e = scope.SessionDAO().(store.SessionResourceDAO).ListSessionResourceLeases(ctx, session.ID)
			return e
		})
		if err != nil {
			return err
		}
		if completion.Outcome != store.TransactionCommitted {
			return errors.New("resource deletion lease observation was not confirmed")
		}
		for _, lease := range leases {
			gate, e := s.files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+lease.ID)
			if e != nil {
				return e
			}
			// The exact filesystem lock was acquired before the durable lease existed.
			// Holding it now proves every previous owner exited, even after a crash.
			completion, e = s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
				return scope.SessionDAO().(store.SessionResourceDAO).ReleaseSessionResourceLease(ctx, session.ID, lease.ID)
			})
			e = errors.Join(e, gate.Close())
			if e != nil {
				return e
			}
			if completion.Outcome != store.TransactionCommitted {
				return errors.New("joined resource lease removal was not confirmed")
			}
		}
		namespace, e := sessionresource.NewNamespace("", session.Owner, session.ID)
		if e != nil {
			return e
		}
		if e = storage.DeleteSessionResources(ctx, namespace); e != nil {
			return &resourceCleanupFailure{e}
		}
		archive, e := sessionarchive.NewNamespace(sessionarchive.Users, session.Owner, session.ID)
		if e != nil {
			return e
		}
		if e = s.files.DeleteSessionArchives(ctx, archive); e != nil {
			return &resourceCleanupFailure{e}
		}
	}
	return nil
}
