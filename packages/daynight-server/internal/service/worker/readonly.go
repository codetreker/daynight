package worker

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
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
	authorize := readOnlyAuthority(database, recheckAPIAccess, false)
	return workerreadonly.New(func(ctx context.Context, p model.Principal, workerID string) error {
		return authorize(ctx, p, workerID, scopepolicy.WorkerInspect)
	})
}

// NewScopedReadOnly checks current PAT policy at each existing credential lock.
// API OAuth retains its dedicated application-profile recheck.
func NewScopedReadOnly(database readOnlyStore, recheckAPIAccess func(context.Context, model.Principal) error) (*workerreadonly.Broker, error) {
	if recheckAPIAccess == nil {
		return nil, errors.New("Worker read-only API authorization is required")
	}
	authorize := readOnlyAuthority(database, recheckAPIAccess, true)
	return workerreadonly.NewWithAuthorization(
		func(ctx context.Context, p model.Principal, workerID string) error {
			return authorize(ctx, p, workerID, scopepolicy.WorkerInspect)
		},
		func(ctx context.Context, p model.Principal, workerID string) error {
			return authorize(ctx, p, workerID, scopepolicy.WorkerReport)
		},
	), nil
}

func readOnlyAuthority(database readOnlyStore, recheckAPIAccess func(context.Context, model.Principal) error, scoped bool) func(context.Context, model.Principal, string, scopepolicy.Operation) error {
	workers := NewWorkers(database)
	return func(ctx context.Context, p model.Principal, workerID string, operation scopepolicy.Operation) error {
		if err := model.RequirePrincipal(p); err != nil {
			return err
		}
		authorization := model.CredentialAuthorization{Principal: p}
		if p.Kind == model.OAuthCredential {
			if err := recheckAPIAccess(ctx, p); err != nil {
				return err
			}
			authorization.Profile = model.OAuthAPIProfile
		} else {
			completion, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
				switch p.Kind {
				case model.PATCredential:
					dao := scope.IdentityDAO()
					_, err := dao.LockActivePAT(ctx, p.UserID, p.CredentialID, time.Now())
					if err != nil {
						return err
					}
					if scoped {
						policies, ok := dao.(store.PATScopeDAO)
						if !ok {
							return errors.New("Worker read-only PAT scope storage is required")
						}
						token, err := policies.ReadLockedPATScope(ctx, p.UserID, p.CredentialID)
						if err != nil {
							return err
						}
						authorization.Profile, authorization.Policy = model.ScopedPATProfile, token.ScopePolicy
					}
					return nil
				case model.SessionCredential:
					authorization.Profile = model.SessionProfile
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
		if scoped {
			if err := scopeadmission.Require(authorization, operation); err != nil {
				return err
			}
		}
		if !workercore.ActiveAt(detail.Worker.LastReportedAt, detail.ObservedAt) {
			return &model.Fault{Code: "offline", Message: "Worker is offline."}
		}
		return nil
	}
}
