package webhook

import (
	"context"
	"errors"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Catalog reports supported event metadata and the selected immutable policy.
func (s *Service) Catalog(ctx context.Context, principal model.Principal) (any, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return nil, err
	}
	var result any
	err := s.DB.ReadWebhookSnapshot(ctx, func(scope store.WebhookReadScope) error {
		if _, err := scope.CredentialDAO().Credential(ctx, principal); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return model.Unauthenticated(err)
			}
			return err
		}
		policy, err := scope.WebhookDAO().Policy(ctx, 1)
		if err != nil {
			return err
		}
		names := []string{"task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"}
		items := make([]any, 0, len(names))
		for _, name := range names {
			items = append(items, map[string]any{"key": name, "wireType": "cc.daynight." + name + ".v1", "schemaVersion": 1, "resourceKind": "project"})
		}
		result = map[string]any{"items": items, "service": map[string]any{"configurationExpansionAvailable": s.ConfigurationExpansionAvailable, "dispatchEnabled": s.DispatchEnabled}, "limits": map[string]any{
			"policyVersion": strconv.FormatInt(policy.Version, 10), "requestBytes": 256 * 1024, "payloadBytes": 64 * 1024,
			"maxAutomaticAttempts": policy.MaxAutomaticAttempts, "automaticWindowSeconds": policy.AutomaticWindowSeconds,
			"maxManualOperations": policy.MaxManualOperations, "payloadRetentionSeconds": policy.PayloadRetentionSeconds,
			"operationMaxAgeSeconds": policy.OperationMaxAgeSeconds, "operationFutureSkewSeconds": policy.OperationFutureSkewSeconds,
		}}
		return nil
	})
	return result, err
}
