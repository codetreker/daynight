package worker

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
)

type readOnlyStore interface {
	workerStore
	store.IdentityWriter
}

// NewReadOnly joins credential authority and owner-scoped Worker observation.
// Directory contents remain transient and never enter Worker telemetry or storage.
func NewReadOnly(database readOnlyStore, recheckAPIAccess func(context.Context, model.Principal) error) *workerreadonly.Broker {
	workers := NewWorkers(database)
	return workerreadonly.New(func(ctx context.Context, p model.Principal, workerID string) error {
		if err := model.RequirePrincipal(p); err != nil {
			return err
		}
		if p.Kind == model.OAuthCredential {
			if err := recheckAPIAccess(ctx, p); err != nil {
				return err
			}
		} else {
			completion, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
				switch p.Kind {
				case model.PATCredential:
					_, err := scope.IdentityDAO().LockActivePAT(ctx, p.UserID, p.CredentialID, time.Now())
					return err
				case model.SessionCredential:
					return scope.IdentityDAO().LockSession(ctx, p, time.Now())
				default:
					return &model.Fault{Code: "unauthenticated", Message: "Worker read-only access requires a current credential."}
				}
			})
			if errors.Is(err, model.ErrNotFound) {
				return &model.Fault{Code: "unauthenticated", Message: "Worker read-only credential expired or was revoked."}
			}
			if err != nil {
				return err
			}
			if completion.Outcome != store.TransactionCommitted {
				return &model.Fault{Code: "service_unavailable", Message: "Worker read-only authority could not be confirmed."}
			}
		}
		detail, err := workers.Get(ctx, p, workerID)
		if err != nil {
			return err
		}
		if !workercore.ActiveAt(detail.Worker.LastReportedAt, detail.ObservedAt) {
			return &model.Fault{Code: "offline", Message: "Worker is offline."}
		}
		return nil
	})
}
