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
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type managementStore interface {
	store.SnapshotReader
	store.WebhookWriter
}

type Settings struct {
	ConfigurationExpansionAvailable bool
	DispatchEnabled                 bool
}

type Manager struct {
	database managementStore
	keys     *secretbox.Keyring
	settings Settings
}

func New(database managementStore, keys *secretbox.Keyring, settings Settings) (*Manager, error) {
	if database == nil || keys == nil {
		return nil, fmt.Errorf("Webhook management requires persistence and an encryption keyring")
	}
	return &Manager{database: database, keys: keys, settings: settings}, nil
}

type SubscriptionResult struct {
	Subscription webhookmodel.Subscription
	ProjectName  *string
	Eligibility  webhookmodel.Eligibility
}

type EndpointResult struct {
	Endpoint      webhookmodel.Endpoint
	Access        webhookmodel.OwnerAccess
	Destination   *webhookmodel.Destination
	Subscriptions []SubscriptionResult
	OverlapUntil  *time.Time
}

type MutationResult struct {
	Operation webhookmodel.OperationReceipt
	Endpoint  EndpointResult
	Replayed  bool
}

type ListResult struct {
	Items      []EndpointResult
	NextCursor *string
}

type SecretResult struct {
	EndpointID    string
	ConfigVersion int64
	KeyID         string
	Secret        string
}

type CatalogResult struct {
	Items    []webhookcore.EventDefinition
	Policy   webhookmodel.Policy
	Settings Settings
}

func readCredential(ctx context.Context, scope store.SnapshotScope, principal model.Principal) error {
	_, err := scope.CredentialDAO().Credential(ctx, principal)
	if errors.Is(err, model.ErrNotFound) {
		return model.Unauthenticated(err)
	}
	return err
}

func requireRequest(principal model.Principal, owner webhookmodel.Owner, input webhookcore.Operation) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	if err := webhookcore.ValidateOwner(owner); err != nil {
		return err
	}
	if input.ExpectedUserID != principal.UserID {
		return &model.Fault{Code: "identity_mismatch", Message: "The expected user does not match the authenticated user."}
	}
	return webhookcore.ValidateOperation(input)
}

func resultError(err error) error {
	// Credential and permission refusals keep their own code even when a
	// missing database row is retained in the cause chain.
	var fault *model.Fault
	if errors.As(err, &fault) {
		return err
	}
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Webhook resource was not found.", Cause: err}
	}
	return err
}

func resourceID(value string) error {
	id, err := model.CanonicalID(value)
	if err != nil || id != value || id == "00000000-0000-0000-0000-000000000000" {
		return &model.Fault{Code: "invalid_input", Message: "Webhook resource ID must be a canonical nonzero UUID."}
	}
	return nil
}

func (s *Manager) Catalog(ctx context.Context, principal model.Principal) (CatalogResult, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return CatalogResult{}, err
	}
	var policy webhookmodel.Policy
	err := s.database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if err := readCredential(ctx, scope, principal); err != nil {
			return err
		}
		var err error
		policy, err = scope.WebhookDAO().Policy(ctx)
		return err
	})
	if err != nil {
		return CatalogResult{}, err
	}
	if err := webhookcore.ValidatePolicy(policy); err != nil {
		return CatalogResult{}, err
	}
	return CatalogResult{Items: webhookcore.Catalog(), Policy: policy, Settings: s.settings}, nil
}

func (s *Manager) endpointResult(ctx context.Context, dao store.WebhookReadDAO, principal model.Principal, owner webhookmodel.Owner, endpoint webhookmodel.Endpoint, access webhookmodel.OwnerAccess, now time.Time, details bool) (EndpointResult, error) {
	if endpoint.Owner != owner || endpoint.ConfigVersion <= 0 || endpoint.DestinationRevision <= 0 {
		return EndpointResult{}, fmt.Errorf("Webhook endpoint identity or version is inconsistent")
	}
	result := EndpointResult{Endpoint: endpoint, Access: access, Subscriptions: []SubscriptionResult{}}
	if endpoint.DeletedAt != nil {
		return result, nil
	}
	keys, err := webhookcore.ActiveSigningKeys(endpoint, now)
	if err != nil {
		return EndpointResult{}, err
	}
	for _, key := range keys {
		if key.ID != endpoint.ActiveKeyID {
			result.OverlapUntil = key.ExpiresAt
		}
	}
	if details && access.CanManage {
		destination, err := s.destination(endpoint)
		if err != nil {
			return EndpointResult{}, err
		}
		result.Destination = &destination
	}
	projects, err := dao.Projects(ctx, owner, principal.UserID, webhookcore.ProjectIDs(endpoint))
	if err != nil {
		return EndpointResult{}, err
	}
	facts := make(map[string]webhookmodel.ProjectAccess, len(projects))
	for _, project := range projects {
		if _, found := facts[project.ProjectID]; found {
			return EndpointResult{}, fmt.Errorf("Webhook project qualification is duplicated")
		}
		facts[project.ProjectID] = project
	}
	for _, subscription := range endpoint.Subscriptions {
		if subscription.DeletedAt != nil {
			continue
		}
		project, exists := facts[subscription.ProjectID]
		if !exists {
			return EndpointResult{}, fmt.Errorf("Webhook project qualification is missing")
		}
		eligibility, err := webhookcore.EligibilityFor(owner, subscription, project)
		if err != nil {
			return EndpointResult{}, err
		}
		var name *string
		if project.Present && project.CanRead && (owner.Kind != webhookmodel.TeamOwner || project.OwnerTeamID == owner.ID) {
			name = project.ProjectName
		}
		result.Subscriptions = append(result.Subscriptions, SubscriptionResult{Subscription: subscription, ProjectName: name, Eligibility: eligibility})
	}
	return result, nil
}

func (s *Manager) Get(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, endpointID string) (EndpointResult, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return EndpointResult{}, err
	}
	if err := webhookcore.ValidateOwner(owner); err != nil {
		return EndpointResult{}, err
	}
	if err := resourceID(endpointID); err != nil {
		return EndpointResult{}, err
	}
	var result EndpointResult
	err := s.database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if err := readCredential(ctx, scope, principal); err != nil {
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
		endpoint, err := dao.Endpoint(ctx, owner, endpointID)
		if err != nil {
			return err
		}
		now, err := scope.ObservedAt(ctx)
		if err != nil {
			return err
		}
		result, err = s.endpointResult(ctx, dao, principal, owner, endpoint, access, now, true)
		return err
	})
	return result, resultError(err)
}

func (s *Manager) List(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, input ListInput) (ListResult, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return ListResult{}, err
	}
	if err := webhookcore.ValidateOwner(owner); err != nil {
		return ListResult{}, err
	}
	input, err := normalizeList(input)
	if err != nil {
		return ListResult{}, err
	}
	result := ListResult{Items: []EndpointResult{}}
	err = s.database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if err := readCredential(ctx, scope, principal); err != nil {
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
		cursor := cursorScope{PrincipalID: principal.UserID, Owner: owner, Search: input.Search, Enabled: input.Enabled, CanManage: access.CanManage}
		page, err := pageFor(input, cursor)
		if err != nil {
			return err
		}
		records, err := dao.Endpoints(ctx, owner, principal.UserID, store.WebhookEndpointQuery{Search: input.Search, Enabled: input.Enabled, Page: page})
		if err != nil {
			return err
		}
		now, err := scope.ObservedAt(ctx)
		if err != nil {
			return err
		}
		for _, endpoint := range records.Items {
			projected, err := s.endpointResult(ctx, dao, principal, owner, endpoint, access, now, false)
			if err != nil {
				return err
			}
			result.Items = append(result.Items, projected)
		}
		if records.HasMore {
			if len(records.Items) == 0 {
				return fmt.Errorf("Webhook endpoint pagination has no continuation position")
			}
			token, err := nextCursor(cursor, records.Items[len(records.Items)-1])
			if err != nil {
				return err
			}
			result.NextCursor = &token
		}
		return nil
	})
	return result, resultError(err)
}

func (s *Manager) Operation(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, operationID string) (webhookmodel.OperationReceipt, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return webhookmodel.OperationReceipt{}, err
	}
	if err := webhookcore.ValidateOwner(owner); err != nil {
		return webhookmodel.OperationReceipt{}, err
	}
	if err := resourceID(operationID); err != nil {
		return webhookmodel.OperationReceipt{}, err
	}
	var result webhookmodel.OperationReceipt
	err := s.database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if err := readCredential(ctx, scope, principal); err != nil {
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
		result, err = dao.Operation(ctx, owner, operationID)
		if err != nil {
			return err
		}
		return webhookcore.RequireReceiptRead(owner, principal.UserID, access, result)
	})
	return result, resultError(err)
}

func (s *Manager) SigningSecret(ctx context.Context, principal model.Principal, owner webhookmodel.Owner, endpointID string) (SecretResult, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return SecretResult{}, err
	}
	if err := webhookcore.ValidateOwner(owner); err != nil {
		return SecretResult{}, err
	}
	if err := resourceID(endpointID); err != nil {
		return SecretResult{}, err
	}
	var result SecretResult
	err := s.database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if err := readCredential(ctx, scope, principal); err != nil {
			return err
		}
		dao := scope.WebhookDAO()
		access, err := dao.OwnerAccess(ctx, owner, principal.UserID)
		if err != nil {
			return err
		}
		if err := webhookcore.RequireOwner(owner, principal.UserID, access, true); err != nil {
			return err
		}
		endpoint, err := dao.Endpoint(ctx, owner, endpointID)
		if err != nil {
			return err
		}
		if endpoint.DeletedAt != nil {
			return model.ErrNotFound
		}
		now, err := scope.ObservedAt(ctx)
		if err != nil {
			return err
		}
		keys, err := webhookcore.ActiveSigningKeys(endpoint, now)
		if err != nil {
			return err
		}
		index := slices.IndexFunc(keys, func(key webhookmodel.SigningKey) bool { return key.ID == endpoint.ActiveKeyID })
		if index < 0 {
			return fmt.Errorf("Webhook primary signing key is missing")
		}
		data, err := s.signingSecret(endpoint, keys[index])
		if err != nil {
			return err
		}
		defer clear(data)
		result = SecretResult{EndpointID: endpoint.ID, ConfigVersion: endpoint.ConfigVersion, KeyID: endpoint.ActiveKeyID, Secret: secretText(data)}
		return nil
	})
	return result, resultError(err)
}
