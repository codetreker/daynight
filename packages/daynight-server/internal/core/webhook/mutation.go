package webhook

import (
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

type PreparedMutation struct {
	Endpoint        webhookmodel.Endpoint
	Destination     *webhookmodel.Destination
	Changed         bool
	NewSigningKeyID string
}

func newID() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

func cloneEndpoint(endpoint webhookmodel.Endpoint) webhookmodel.Endpoint {
	endpoint.EncryptedDestination = slices.Clone(endpoint.EncryptedDestination)
	endpoint.SigningKeys = slices.Clone(endpoint.SigningKeys)
	for i := range endpoint.SigningKeys {
		endpoint.SigningKeys[i].EncryptedSecret = slices.Clone(endpoint.SigningKeys[i].EncryptedSecret)
	}
	endpoint.Subscriptions = slices.Clone(endpoint.Subscriptions)
	for i := range endpoint.Subscriptions {
		endpoint.Subscriptions[i].Bindings = slices.Clone(endpoint.Subscriptions[i].Bindings)
	}
	return endpoint
}

func newSubscription(input SubscriptionInput) (webhookmodel.Subscription, error) {
	id, err := newID()
	if err != nil {
		return webhookmodel.Subscription{}, err
	}
	result := webhookmodel.Subscription{ID: id, ProjectID: input.ProjectID, AuthorizationState: webhookmodel.AuthorizationActive, AuthorizationEpoch: 1, Bindings: make([]webhookmodel.Binding, 0, len(input.EventTypes))}
	for _, key := range input.EventTypes {
		id, err := newID()
		if err != nil {
			return webhookmodel.Subscription{}, err
		}
		result.Bindings = append(result.Bindings, webhookmodel.Binding{ID: id, EventType: key})
	}
	return result, nil
}

func PrepareCreate(input CreateInput, owner webhookmodel.Owner, access webhookmodel.OwnerAccess, projects []webhookmodel.ProjectAccess, now time.Time) (PreparedMutation, error) {
	input, err := NormalizeCreate(input)
	if err != nil {
		return PreparedMutation{}, err
	}
	if err := RequireOwner(owner, input.ExpectedUserID, access, true); err != nil {
		return PreparedMutation{}, err
	}
	facts, err := projectFacts(projects)
	if err != nil {
		return PreparedMutation{}, err
	}
	id, err := newID()
	if err != nil {
		return PreparedMutation{}, err
	}
	keyID, err := newID()
	if err != nil {
		return PreparedMutation{}, err
	}
	origin, err := DestinationOrigin(input.Destination)
	if err != nil {
		return PreparedMutation{}, err
	}
	endpoint := webhookmodel.Endpoint{ID: id, Owner: owner, Name: input.Name, Enabled: input.Enabled, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: input.Destination.Kind, AdapterVersion: input.Destination.AdapterVersion, DestinationOrigin: origin, ActiveKeyID: keyID, SigningKeys: []webhookmodel.SigningKey{{ID: keyID, CreatedAt: now.UTC()}}, Subscriptions: []webhookmodel.Subscription{}, CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
	for _, selection := range input.Subscriptions {
		if err := requireProject(owner, selection.ProjectID, facts); err != nil {
			return PreparedMutation{}, err
		}
		subscription, err := newSubscription(selection)
		if err != nil {
			return PreparedMutation{}, err
		}
		endpoint.Subscriptions = append(endpoint.Subscriptions, subscription)
	}
	if err := ValidateConfigurationMetadata(endpoint); err != nil {
		return PreparedMutation{}, err
	}
	return PreparedMutation{Endpoint: endpoint, Destination: &input.Destination, Changed: true, NewSigningKeyID: keyID}, nil
}

func existingSubscriptions(endpoint webhookmodel.Endpoint) (map[string]webhookmodel.Subscription, error) {
	result := make(map[string]webhookmodel.Subscription)
	for _, subscription := range endpoint.Subscriptions {
		if err := canonicalID(subscription.ID); err != nil {
			return nil, fmt.Errorf("invalid stored Webhook subscription identity: %w", err)
		}
		if _, duplicate := result[subscription.ID]; duplicate {
			return nil, fmt.Errorf("duplicate stored Webhook subscription identity")
		}
		if subscription.DeletedAt == nil {
			result[subscription.ID] = subscription
		}
	}
	return result, nil
}

func activeEvents(subscription webhookmodel.Subscription) map[string]struct{} {
	result := make(map[string]struct{})
	for _, binding := range subscription.Bindings {
		if binding.DeletedAt == nil {
			result[binding.EventType] = struct{}{}
		}
	}
	return result
}

func RequiredProjectIDs(current webhookmodel.Endpoint, input PatchInput) []string {
	ids := slices.Clone(input.ConfirmProjectIDs)
	if input.Subscriptions != nil {
		for _, selection := range *input.Subscriptions {
			required := selection.ID == nil
			if selection.ID != nil {
				index := slices.IndexFunc(current.Subscriptions, func(subscription webhookmodel.Subscription) bool {
					return subscription.ID == *selection.ID && subscription.DeletedAt == nil
				})
				if index < 0 {
					required = true
				} else {
					events := activeEvents(current.Subscriptions[index])
					for _, key := range selection.EventTypes {
						if _, exists := events[key]; !exists {
							required = true
						}
					}
				}
			}
			if required || input.Enabled != nil && *input.Enabled && !current.Enabled {
				ids = append(ids, selection.ProjectID)
			}
		}
	} else if input.Enabled != nil && *input.Enabled && !current.Enabled {
		ids = append(ids, ProjectIDs(current)...)
	}
	slices.Sort(ids)
	return slices.Compact(ids)
}

func IsExpansion(current webhookmodel.Endpoint, input PatchInput) bool {
	return len(RequiredProjectIDs(current, input)) > 0 || input.Enabled != nil && *input.Enabled && !current.Enabled
}

func ProjectIDs(endpoint webhookmodel.Endpoint) []string {
	ids := []string{}
	for _, subscription := range endpoint.Subscriptions {
		if subscription.DeletedAt == nil {
			ids = append(ids, subscription.ProjectID)
		}
	}
	slices.Sort(ids)
	return slices.Compact(ids)
}

func checkCurrent(current webhookmodel.Endpoint, expectedVersion int64) error {
	if current.DeletedAt != nil {
		return model.ErrNotFound
	}
	if current.ConfigVersion != expectedVersion {
		return fault("version_conflict", "The Webhook configuration version has changed.")
	}
	if current.ConfigVersion <= 0 || current.DestinationRevision <= 0 {
		return fmt.Errorf("stored Webhook configuration versions are invalid")
	}
	return nil
}

func advanceVersion(endpoint *webhookmodel.Endpoint, destination bool, now time.Time) error {
	if endpoint.ConfigVersion == math.MaxInt64 || destination && endpoint.DestinationRevision == math.MaxInt64 {
		return fmt.Errorf("Webhook configuration version is exhausted")
	}
	endpoint.ConfigVersion++
	if destination {
		endpoint.DestinationRevision++
	}
	endpoint.UpdatedAt = now.UTC()
	return nil
}

func replaceSubscriptions(current webhookmodel.Endpoint, selections []SubscriptionInput, facts map[string]webhookmodel.ProjectAccess, now time.Time) ([]webhookmodel.Subscription, bool, error) {
	old, err := existingSubscriptions(current)
	if err != nil {
		return nil, false, err
	}
	selected := make(map[string]SubscriptionInput)
	added := []webhookmodel.Subscription{}
	changed := false
	for _, selection := range selections {
		if selection.ID == nil {
			if err := requireProject(current.Owner, selection.ProjectID, facts); err != nil {
				return nil, false, err
			}
			subscription, err := newSubscription(selection)
			if err != nil {
				return nil, false, err
			}
			added = append(added, subscription)
			changed = true
			continue
		}
		subscription, exists := old[*selection.ID]
		if !exists || subscription.ProjectID != selection.ProjectID {
			return nil, false, invalid("A retained subscription must belong to this endpoint and keep its project ID.")
		}
		for _, key := range selection.EventTypes {
			if _, exists := activeEvents(subscription)[key]; !exists {
				if err := requireProject(current.Owner, selection.ProjectID, facts); err != nil {
					return nil, false, err
				}
			}
		}
		selected[subscription.ID] = selection
	}
	result := slices.Clone(current.Subscriptions)
	for i := range result {
		subscription := &result[i]
		subscription.Bindings = slices.Clone(subscription.Bindings)
		if subscription.DeletedAt != nil {
			continue
		}
		selection, retained := selected[subscription.ID]
		if !retained {
			timestamp := now.UTC()
			subscription.DeletedAt = &timestamp
			for j := range subscription.Bindings {
				if subscription.Bindings[j].DeletedAt == nil {
					subscription.Bindings[j].DeletedAt = &timestamp
				}
			}
			changed = true
			continue
		}
		events := activeEvents(*subscription)
		for j := range subscription.Bindings {
			binding := &subscription.Bindings[j]
			if binding.DeletedAt == nil && !slices.Contains(selection.EventTypes, binding.EventType) {
				timestamp := now.UTC()
				binding.DeletedAt = &timestamp
				changed = true
			}
		}
		for _, key := range selection.EventTypes {
			if _, exists := events[key]; exists {
				continue
			}
			id, err := newID()
			if err != nil {
				return nil, false, err
			}
			subscription.Bindings = append(subscription.Bindings, webhookmodel.Binding{ID: id, EventType: key})
			changed = true
		}
	}
	return append(result, added...), changed, nil
}

func PreparePatch(input PatchInput, current webhookmodel.Endpoint, currentDestination webhookmodel.Destination, access webhookmodel.OwnerAccess, projects []webhookmodel.ProjectAccess, now time.Time) (PreparedMutation, error) {
	input, err := NormalizePatch(input)
	if err != nil {
		return PreparedMutation{}, err
	}
	if err := RequireOwner(current.Owner, input.ExpectedUserID, access, true); err != nil {
		return PreparedMutation{}, err
	}
	if err := checkCurrent(current, input.IfVersion); err != nil {
		return PreparedMutation{}, err
	}
	facts, err := projectFacts(projects)
	if err != nil {
		return PreparedMutation{}, err
	}
	result := cloneEndpoint(current)
	changed, destinationChanged := false, false
	if input.Name != nil && *input.Name != result.Name {
		result.Name = *input.Name
		changed = true
	}
	if input.Enabled != nil && *input.Enabled != result.Enabled {
		result.Enabled = *input.Enabled
		changed = true
	}
	var destination *webhookmodel.Destination
	if input.Destination != nil {
		if err := ValidateDestination(currentDestination); err != nil {
			return PreparedMutation{}, fmt.Errorf("stored Webhook destination is invalid: %w", err)
		}
		if *input.Destination != currentDestination {
			origin, err := DestinationOrigin(*input.Destination)
			if err != nil {
				return PreparedMutation{}, err
			}
			result.DestinationKind, result.AdapterVersion, result.DestinationOrigin = input.Destination.Kind, input.Destination.AdapterVersion, origin
			result.EncryptedDestination = nil
			destination = input.Destination
			changed, destinationChanged = true, true
		}
	}
	if input.Subscriptions != nil {
		var subscriptionsChanged bool
		result.Subscriptions, subscriptionsChanged, err = replaceSubscriptions(current, *input.Subscriptions, facts, now)
		if err != nil {
			return PreparedMutation{}, err
		}
		changed = changed || subscriptionsChanged
	}
	finalProjectIDs := ProjectIDs(result)
	for _, projectID := range input.ConfirmProjectIDs {
		if !slices.Contains(finalProjectIDs, projectID) {
			return PreparedMutation{}, invalid("A confirmation must refer to a final subscription project.")
		}
		if err := requireProject(result.Owner, projectID, facts); err != nil {
			return PreparedMutation{}, err
		}
		for i := range result.Subscriptions {
			subscription := &result.Subscriptions[i]
			if subscription.DeletedAt == nil && subscription.ProjectID == projectID && subscription.AuthorizationState == webhookmodel.AuthorizationConfirmationRequired {
				subscription.AuthorizationState = webhookmodel.AuthorizationActive
				changed = true
			}
		}
	}
	if input.Enabled != nil && *input.Enabled && !current.Enabled {
		for _, projectID := range finalProjectIDs {
			if err := requireProject(result.Owner, projectID, facts); err != nil {
				return PreparedMutation{}, err
			}
		}
	}
	if changed {
		if err := advanceVersion(&result, destinationChanged, now); err != nil {
			return PreparedMutation{}, err
		}
	}
	if err := ValidateConfigurationMetadata(result); err != nil {
		return PreparedMutation{}, err
	}
	return PreparedMutation{Endpoint: result, Destination: destination, Changed: changed}, nil
}

func PrepareDelete(input DeleteInput, current webhookmodel.Endpoint, access webhookmodel.OwnerAccess, now time.Time) (PreparedMutation, error) {
	input, err := NormalizeDelete(input)
	if err != nil {
		return PreparedMutation{}, err
	}
	if err := RequireOwner(current.Owner, input.ExpectedUserID, access, true); err != nil {
		return PreparedMutation{}, err
	}
	if err := checkCurrent(current, input.IfVersion); err != nil {
		return PreparedMutation{}, err
	}
	result := cloneEndpoint(current)
	timestamp := now.UTC()
	result.DeletedAt, result.Enabled = &timestamp, false
	result.Name, result.DestinationOrigin, result.ActiveKeyID = "", "", ""
	result.EncryptedDestination, result.SigningKeys = nil, []webhookmodel.SigningKey{}
	for i := range result.Subscriptions {
		subscription := &result.Subscriptions[i]
		if subscription.DeletedAt == nil {
			subscription.DeletedAt = &timestamp
		}
		for j := range subscription.Bindings {
			if subscription.Bindings[j].DeletedAt == nil {
				subscription.Bindings[j].DeletedAt = &timestamp
			}
		}
	}
	if err := advanceVersion(&result, false, now); err != nil {
		return PreparedMutation{}, err
	}
	if err := ValidateConfigurationMetadata(result); err != nil {
		return PreparedMutation{}, err
	}
	return PreparedMutation{Endpoint: result, Changed: true}, nil
}

func PrepareRotation(input RotateInput, current webhookmodel.Endpoint, access webhookmodel.OwnerAccess, now time.Time) (PreparedMutation, error) {
	input, err := NormalizeRotation(input)
	if err != nil {
		return PreparedMutation{}, err
	}
	if err := RequireOwner(current.Owner, input.ExpectedUserID, access, true); err != nil {
		return PreparedMutation{}, err
	}
	if err := checkCurrent(current, input.IfVersion); err != nil {
		return PreparedMutation{}, err
	}
	keys, err := ActiveSigningKeys(current, now)
	if err != nil {
		return PreparedMutation{}, err
	}
	if input.Mode == "overlap" && len(keys) > 1 {
		return PreparedMutation{}, fault("resource_conflict", "End the existing signing key overlap before opening another window.")
	}
	keyID, err := newID()
	if err != nil {
		return PreparedMutation{}, err
	}
	result := cloneEndpoint(current)
	result.ActiveKeyID = keyID
	result.SigningKeys = []webhookmodel.SigningKey{{ID: keyID, CreatedAt: now.UTC()}}
	if input.Mode == "overlap" {
		primaryIndex := slices.IndexFunc(keys, func(key webhookmodel.SigningKey) bool { return key.ID == current.ActiveKeyID })
		if primaryIndex < 0 {
			return PreparedMutation{}, fmt.Errorf("Webhook primary signing key is missing")
		}
		previous := keys[primaryIndex]
		expires := now.UTC().Add(24 * time.Hour)
		previous.ExpiresAt = &expires
		result.SigningKeys = append(result.SigningKeys, previous)
	}
	if err := advanceVersion(&result, false, now); err != nil {
		return PreparedMutation{}, err
	}
	if err := ValidateConfigurationMetadata(result); err != nil {
		return PreparedMutation{}, err
	}
	return PreparedMutation{Endpoint: result, Changed: true, NewSigningKeyID: keyID}, nil
}

// Every retained configuration row is charged a fixed envelope, with opaque
// ciphertext bytes added exactly. Retired proofs remain charged until safe GC.
func ConfigurationCost(endpoint webhookmodel.Endpoint) (store.WebhookChangeCost, error) {
	if err := ValidateConfigurationMetadata(endpoint); err != nil {
		return store.WebhookChangeCost{}, err
	}
	cost := store.WebhookChangeCost{Records: 1, Bytes: 2<<10 + int64(len(endpoint.EncryptedDestination))}
	if endpoint.DeletedAt == nil {
		cost.ActiveRecords, cost.ActiveBytes = 1, cost.Bytes
	}
	for _, subscription := range endpoint.Subscriptions {
		cost.Records++
		cost.Bytes += 2 << 10
		if subscription.DeletedAt == nil && endpoint.DeletedAt == nil {
			cost.ActiveRecords++
			cost.ActiveBytes += 2 << 10
		}
		for _, binding := range subscription.Bindings {
			cost.Records++
			cost.Bytes += 2 << 10
			if binding.DeletedAt == nil && subscription.DeletedAt == nil && endpoint.DeletedAt == nil {
				cost.ActiveRecords++
				cost.ActiveBytes += 2 << 10
			}
		}
	}
	for _, key := range endpoint.SigningKeys {
		bytes := 2<<10 + int64(len(key.EncryptedSecret))
		cost.Records++
		cost.Bytes += bytes
		if key.RevokedAt == nil && endpoint.DeletedAt == nil {
			cost.ActiveRecords++
			cost.ActiveBytes += bytes
		}
	}
	return cost, nil
}

func CostDifference(after, before store.WebhookChangeCost) store.WebhookChangeCost {
	return store.WebhookChangeCost{Records: after.Records - before.Records, Bytes: after.Bytes - before.Bytes, ActiveRecords: after.ActiveRecords - before.ActiveRecords, ActiveBytes: after.ActiveBytes - before.ActiveBytes}
}
