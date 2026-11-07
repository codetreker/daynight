package webhook

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type mutation struct {
	operation        webhookcore.Operation
	kind             webhookmodel.OperationKind
	target           string
	input            any
	projectIDs       func(webhookmodel.Endpoint) []string
	requiredProjects func(webhookmodel.Endpoint) []string
	expansion        func(webhookmodel.Endpoint) bool
	prepare          func(webhookmodel.Endpoint, webhookmodel.OwnerAccess, []webhookmodel.ProjectAccess, time.Time) (webhookcore.PreparedMutation, error)
}

func (s *Manager) Create(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, input webhookcore.CreateInput) (MutationResult, error) {
	if err := requireRequest(principal, owner, input.Operation); err != nil {
		return MutationResult{}, err
	}
	input, err := webhookcore.NormalizeCreate(input)
	if err != nil {
		return MutationResult{}, err
	}
	ids := []string{}
	for _, subscription := range input.Subscriptions {
		ids = append(ids, subscription.ProjectID)
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	return s.mutate(ctx, principal, owner, mutation{
		operation: input.Operation, kind: webhookmodel.EndpointCreate, input: input,
		projectIDs:       func(webhookmodel.Endpoint) []string { return ids },
		requiredProjects: func(webhookmodel.Endpoint) []string { return ids },
		expansion:        func(webhookmodel.Endpoint) bool { return true },
		prepare: func(_ webhookmodel.Endpoint, access webhookmodel.OwnerAccess, projects []webhookmodel.ProjectAccess, now time.Time) (webhookcore.PreparedMutation, error) {
			return webhookcore.PrepareCreate(input, owner, access, projects, now)
		},
	})
}

func (s *Manager) Patch(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, endpointID string, input webhookcore.PatchInput) (MutationResult, error) {
	if err := requireRequest(principal, owner, input.Operation); err != nil {
		return MutationResult{}, err
	}
	input, err := webhookcore.NormalizePatch(input)
	if err != nil {
		return MutationResult{}, err
	}
	return s.mutate(ctx, principal, owner, mutation{
		operation: input.Operation, kind: webhookmodel.EndpointPatch, target: endpointID, input: input,
		projectIDs: func(current webhookmodel.Endpoint) []string {
			ids := append(webhookcore.ProjectIDs(current), input.ConfirmProjectIDs...)
			if input.Subscriptions != nil {
				for _, subscription := range *input.Subscriptions {
					ids = append(ids, subscription.ProjectID)
				}
			}
			slices.Sort(ids)
			return slices.Compact(ids)
		},
		requiredProjects: func(current webhookmodel.Endpoint) []string { return webhookcore.RequiredProjectIDs(current, input) },
		expansion:        func(current webhookmodel.Endpoint) bool { return webhookcore.IsExpansion(current, input) },
		prepare: func(current webhookmodel.Endpoint, access webhookmodel.OwnerAccess, projects []webhookmodel.ProjectAccess, now time.Time) (webhookcore.PreparedMutation, error) {
			destination, err := s.destination(current)
			if err != nil {
				return webhookcore.PreparedMutation{}, err
			}
			return webhookcore.PreparePatch(input, current, destination, access, projects, now)
		},
	})
}

func (s *Manager) Delete(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, endpointID string, input webhookcore.DeleteInput) (MutationResult, error) {
	if err := requireRequest(principal, owner, input.Operation); err != nil {
		return MutationResult{}, err
	}
	input, err := webhookcore.NormalizeDelete(input)
	if err != nil {
		return MutationResult{}, err
	}
	return s.mutate(ctx, principal, owner, mutation{
		operation: input.Operation, kind: webhookmodel.EndpointDelete, target: endpointID, input: input,
		projectIDs:       webhookcore.ProjectIDs,
		requiredProjects: func(webhookmodel.Endpoint) []string { return nil },
		expansion:        func(webhookmodel.Endpoint) bool { return false },
		prepare: func(current webhookmodel.Endpoint, access webhookmodel.OwnerAccess, _ []webhookmodel.ProjectAccess, now time.Time) (webhookcore.PreparedMutation, error) {
			return webhookcore.PrepareDelete(input, current, access, now)
		},
	})
}

func (s *Manager) Rotate(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, endpointID string, input webhookcore.RotateInput) (MutationResult, error) {
	if err := requireRequest(principal, owner, input.Operation); err != nil {
		return MutationResult{}, err
	}
	input, err := webhookcore.NormalizeRotation(input)
	if err != nil {
		return MutationResult{}, err
	}
	return s.mutate(ctx, principal, owner, mutation{
		operation: input.Operation, kind: webhookmodel.SecretRotate, target: endpointID, input: input,
		projectIDs:       webhookcore.ProjectIDs,
		requiredProjects: func(webhookmodel.Endpoint) []string { return nil },
		expansion:        func(webhookmodel.Endpoint) bool { return false },
		prepare: func(current webhookmodel.Endpoint, access webhookmodel.OwnerAccess, _ []webhookmodel.ProjectAccess, now time.Time) (webhookcore.PreparedMutation, error) {
			return webhookcore.PrepareRotation(input, current, access, now)
		},
	})
}

func (s *Manager) precheck(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, target string) (webhookmodel.Endpoint, error) {
	var current webhookmodel.Endpoint
	err := s.database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if err := readCredential(ctx, scope, principal); err != nil {
			return err
		}
		dao := scope.WebhookDAO()
		access, err := dao.OwnerAccess(ctx, owner, principal.UserID)
		if err != nil {
			return err
		}
		// A current member may recover their own previously applied operation
		// after losing management rights; only a new effect requires management.
		if err := webhookcore.RequireOwner(owner, principal.UserID, access, false); err != nil {
			return err
		}
		if target != "" {
			current, err = dao.Endpoint(ctx, owner, target)
			if errors.Is(err, model.ErrNotFound) {
				return nil
			}
			return err
		}
		return nil
	})
	return current, err
}

func (s *Manager) mutate(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, request mutation) (MutationResult, error) {
	fingerprint, err := webhookcore.Fingerprint(request.kind, owner, request.target, request.input)
	if err != nil {
		return MutationResult{}, err
	}
	preimage, err := s.precheck(ctx, principal, owner, request.target)
	if err != nil {
		return MutationResult{}, resultError(err)
	}
	var result MutationResult
	completion, err := s.database.WriteWebhook(ctx, owner, request.operation.ID, func(scope store.WebhookWriteScope) error {
		if _, err := scope.CredentialDAO().Credential(ctx, principal); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return model.Unauthenticated(err)
			}
			return err
		}
		dao := scope.WebhookDAO()
		access, err := dao.OwnerAccess(ctx, owner, principal.UserID)
		if err != nil {
			return err
		}
		if err := webhookcore.RequireOwner(owner, principal.UserID, access, false); err != nil {
			return err
		}
		receipt, err := dao.Operation(ctx, owner, request.operation.ID)
		if err == nil {
			if err := webhookcore.RequireReceiptRead(owner, principal.UserID, access, receipt); err != nil {
				return err
			}
			if err := webhookcore.MatchReceipt(receipt, request.operation, request.kind, owner, request.target, fingerprint); err != nil {
				return err
			}
			endpoint, err := dao.Endpoint(ctx, owner, receipt.EndpointID)
			if err != nil {
				return err
			}
			now, err := scope.ObservedAt(ctx)
			if err != nil {
				return err
			}
			projected, err := s.endpointResult(ctx, dao, principal, owner, endpoint, access, now, true)
			if err != nil {
				return err
			}
			result = MutationResult{Operation: receipt, Endpoint: projected, Replayed: true}
			return nil
		}
		if !errors.Is(err, model.ErrNotFound) {
			return err
		}
		policy, err := dao.Policy(ctx)
		if err != nil {
			return err
		}
		if err := webhookcore.ValidatePolicy(policy); err != nil {
			return err
		}
		now, err := scope.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if err := webhookcore.CheckOperationTime(request.operation, now, policy); err != nil {
			return err
		}
		expands := request.expansion(preimage)
		if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: owner, ActorUserID: principal.UserID, EndpointID: request.target, ProjectIDs: request.projectIDs(preimage), RequiredProjectIDs: request.requiredProjects(preimage), Expansion: expands}); err != nil {
			return err
		}
		access, err = dao.OwnerAccess(ctx, owner, principal.UserID)
		if err != nil {
			return err
		}
		if err := webhookcore.RequireOwner(owner, principal.UserID, access, true); err != nil {
			return err
		}
		if expands && !s.settings.ConfigurationExpansionAvailable {
			return &model.Fault{Code: "webhooks_unavailable", Message: "Webhook configuration expansion is currently unavailable."}
		}
		current := webhookmodel.Endpoint{}
		if request.target != "" {
			current, err = dao.Endpoint(ctx, owner, request.target)
			if err != nil {
				return err
			}
		}
		projects, err := dao.Projects(ctx, owner, principal.UserID, request.projectIDs(current))
		if err != nil {
			return err
		}
		now, err = scope.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if err := webhookcore.CheckOperationTime(request.operation, now, policy); err != nil {
			return err
		}
		if _, err := scope.CredentialDAO().Credential(ctx, principal); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return model.Unauthenticated(err)
			}
			return err
		}
		prepared, err := request.prepare(current, access, projects, now)
		if err != nil {
			return err
		}
		if err := s.completeEncryptedMutation(&prepared); err != nil {
			return err
		}
		if err := dao.ReserveOperation(ctx, owner, now); err != nil {
			return err
		}
		if prepared.Changed {
			before := store.WebhookChangeCost{}
			if request.target != "" {
				before, err = webhookcore.ConfigurationCost(current)
				if err != nil {
					return err
				}
			}
			after, err := webhookcore.ConfigurationCost(prepared.Endpoint)
			if err != nil {
				return err
			}
			if err := dao.ReserveConfiguration(ctx, owner, webhookcore.CostDifference(after, before)); err != nil {
				return err
			}
			if request.kind == webhookmodel.EndpointCreate {
				if err := dao.InsertEndpoint(ctx, prepared.Endpoint); err != nil {
					return err
				}
			} else if err := dao.SaveEndpoint(ctx, prepared.Endpoint, current.ConfigVersion); err != nil {
				return err
			}
		}
		receipt = webhookmodel.OperationReceipt{OperationID: request.operation.ID, Kind: request.kind, IssuedAt: request.operation.IssuedAt, RequestSHA256: request.operation.RequestSHA256, Fingerprint: fingerprint,
			ActorUserID: principal.UserID, Owner: owner, EndpointID: prepared.Endpoint.ID, Effect: webhookmodel.EffectUnchanged, ConfigVersionAfter: prepared.Endpoint.ConfigVersion,
			DestinationRevisionAfter: prepared.Endpoint.DestinationRevision, RecordedAt: now.UTC(), ExpiresAt: now.UTC().Add(time.Duration(policy.OperationRetentionSeconds) * time.Second)}
		if prepared.Changed {
			receipt.Effect = webhookmodel.EffectApplied
		}
		if prepared.NewSigningKeyID != "" && request.kind == webhookmodel.SecretRotate {
			receipt.KeyID = &prepared.NewSigningKeyID
			for _, key := range prepared.Endpoint.SigningKeys {
				if key.ID != prepared.NewSigningKeyID {
					receipt.SigningOverlapUntil = key.ExpiresAt
				}
			}
		}
		if err := dao.InsertOperation(ctx, receipt); err != nil {
			return err
		}
		projected, err := s.endpointResult(ctx, dao, principal, owner, prepared.Endpoint, access, now, true)
		if err != nil {
			return err
		}
		result = MutationResult{Operation: receipt, Endpoint: projected}
		return nil
	})
	if err != nil {
		return MutationResult{}, resultError(err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return MutationResult{}, &store.TransactionError{Phase: "completion", Outcome: completion.Outcome, Cause: fmt.Errorf("Webhook transaction did not confirm commit")}
	}
	return result, nil
}
