package webhook

import (
	"fmt"
	"time"

	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func RequireOwner(owner webhookmodel.Owner, actorUserID string, access webhookmodel.OwnerAccess, manage bool) error {
	if err := ValidateOwner(owner); err != nil {
		return err
	}
	if err := canonicalID(actorUserID); err != nil {
		return err
	}
	if owner.Kind == webhookmodel.PersonalOwner && owner.ID != actorUserID {
		return fault("forbidden", "Personal Webhooks belong to the authenticated user.")
	}
	if manage && !access.CanManage || !manage && !access.CanRead {
		return fault("forbidden", "Current Webhook owner permissions do not allow this operation.")
	}
	return nil
}

func RequireReceiptRead(owner webhookmodel.Owner, actorUserID string, access webhookmodel.OwnerAccess, receipt webhookmodel.OperationReceipt) error {
	if err := RequireOwner(owner, actorUserID, access, false); err != nil {
		return err
	}
	if receipt.Owner != owner {
		return fmt.Errorf("Webhook receipt owner is inconsistent")
	}
	if !access.CanManage && receipt.ActorUserID != actorUserID {
		return fault("forbidden", "Only a manager or the original actor can read this operation receipt.")
	}
	return nil
}

func MatchReceipt(receipt webhookmodel.OperationReceipt, operation Operation, kind webhookmodel.OperationKind, owner webhookmodel.Owner, target, fingerprint string) error {
	if receipt.OperationID != operation.ID || receipt.Kind != kind || receipt.Owner != owner || receipt.ActorUserID != operation.ExpectedUserID || receipt.IssuedAt != operation.IssuedAt || receipt.Fingerprint != fingerprint || target != "" && receipt.EndpointID != target {
		return fault("operation_conflict", "This operation ID is already bound to a different request.")
	}
	return nil
}

func EligibilityFor(owner webhookmodel.Owner, subscription webhookmodel.Subscription, project webhookmodel.ProjectAccess) (webhookmodel.Eligibility, error) {
	if project.ProjectID != subscription.ProjectID {
		return "", fmt.Errorf("Webhook project qualification belongs to a different project")
	}
	if subscription.AuthorizationState != webhookmodel.AuthorizationActive && subscription.AuthorizationState != webhookmodel.AuthorizationConfirmationRequired || subscription.AuthorizationEpoch <= 0 {
		return "", fmt.Errorf("Webhook subscription authorization is invalid")
	}
	if !project.Present {
		return webhookmodel.ResourceUnavailable, nil
	}
	if owner.Kind == webhookmodel.TeamOwner && owner.ID != project.OwnerTeamID {
		return webhookmodel.OwnerScopeChanged, nil
	}
	if !project.CanRead {
		return webhookmodel.AccessRevoked, nil
	}
	if subscription.AuthorizationState == webhookmodel.AuthorizationConfirmationRequired {
		return webhookmodel.ConfirmationRequired, nil
	}
	return webhookmodel.Eligible, nil
}

func projectFacts(projects []webhookmodel.ProjectAccess) (map[string]webhookmodel.ProjectAccess, error) {
	facts := make(map[string]webhookmodel.ProjectAccess, len(projects))
	for _, project := range projects {
		if err := canonicalID(project.ProjectID); err != nil {
			return nil, fmt.Errorf("Webhook project qualification has an invalid identity: %w", err)
		}
		if _, present := facts[project.ProjectID]; present {
			return nil, fmt.Errorf("Webhook project qualification is duplicated")
		}
		facts[project.ProjectID] = project
	}
	return facts, nil
}

func requireProject(owner webhookmodel.Owner, projectID string, facts map[string]webhookmodel.ProjectAccess) error {
	project, exists := facts[projectID]
	if !exists {
		return fmt.Errorf("Webhook project qualification is missing")
	}
	if !project.Present || !project.CanRead || owner.Kind == webhookmodel.TeamOwner && owner.ID != project.OwnerTeamID {
		return fault("forbidden", "A subscription requires current access within its owner's selected scope.")
	}
	return nil
}

func ActiveSigningKeys(endpoint webhookmodel.Endpoint, now time.Time) ([]webhookmodel.SigningKey, error) {
	if endpoint.DeletedAt != nil {
		return []webhookmodel.SigningKey{}, nil
	}
	keys := make([]webhookmodel.SigningKey, 0, 2)
	active := false
	identities := make(map[string]struct{}, len(endpoint.SigningKeys))
	for _, key := range endpoint.SigningKeys {
		if err := canonicalID(key.ID); err != nil {
			return nil, fmt.Errorf("Webhook signing key identity is invalid: %w", err)
		}
		if _, exists := identities[key.ID]; exists {
			return nil, fmt.Errorf("Webhook signing key identity is duplicated")
		}
		identities[key.ID] = struct{}{}
		if key.RevokedAt != nil || key.ExpiresAt != nil && !key.ExpiresAt.After(now) {
			continue
		}
		if key.ID != endpoint.ActiveKeyID && key.ExpiresAt == nil {
			return nil, fmt.Errorf("Webhook secondary signing key lacks its overlap deadline")
		}
		if key.ID == endpoint.ActiveKeyID {
			if key.ExpiresAt != nil {
				return nil, fmt.Errorf("Webhook primary signing key has an expiry")
			}
			active = true
		}
		keys = append(keys, key)
	}
	if !active || len(keys) > 2 {
		return nil, fmt.Errorf("Webhook signing key state is inconsistent")
	}
	return keys, nil
}
