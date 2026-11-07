package webhook

import (
	"encoding/json"
	"fmt"
	"time"

	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// Subscription and binding creation clocks are persistence-owned. Their maximum
// UTC representation is charged when proving the fixed metadata envelope.
const metadataTimestamp = "9999-12-31T23:59:59.999999999Z"

type endpointMetadata struct {
	ID                  string                 `json:"id"`
	OwnerKind           webhookmodel.OwnerKind `json:"owner_kind"`
	OwnerID             string                 `json:"owner_id"`
	Name                string                 `json:"name"`
	Enabled             bool                   `json:"enabled"`
	ConfigVersion       int64                  `json:"config_version"`
	DestinationRevision int64                  `json:"destination_revision"`
	DestinationKind     string                 `json:"destination_kind"`
	AdapterVersion      int64                  `json:"adapter_version"`
	DestinationOrigin   string                 `json:"destination_origin"`
	ActiveKeyID         string                 `json:"active_key_id"`
	CreatedAt           time.Time              `json:"created_at"`
	UpdatedAt           time.Time              `json:"updated_at"`
	DeletedAt           *time.Time             `json:"deleted_at"`
}

type subscriptionMetadata struct {
	ID                 string                          `json:"id"`
	EndpointID         string                          `json:"endpoint_id"`
	OwnerKind          webhookmodel.OwnerKind          `json:"owner_kind"`
	OwnerID            string                          `json:"owner_id"`
	ProjectID          string                          `json:"project_id"`
	AuthorizationState webhookmodel.AuthorizationState `json:"authorization_state"`
	AuthorizationEpoch int64                           `json:"authorization_epoch"`
	CreatedAt          string                          `json:"created_at"`
	UpdatedAt          string                          `json:"updated_at"`
	DeletedAt          *time.Time                      `json:"deleted_at"`
}

type bindingMetadata struct {
	ID             string     `json:"id"`
	SubscriptionID string     `json:"subscription_id"`
	EventType      string     `json:"event_type"`
	CreatedAt      string     `json:"created_at"`
	DeletedAt      *time.Time `json:"deleted_at"`
}

type signingMetadata struct {
	ID         string     `json:"id"`
	EndpointID string     `json:"endpoint_id"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
}

func endpointRecordMetadata(endpoint webhookmodel.Endpoint) endpointMetadata {
	return endpointMetadata{
		ID: endpoint.ID, OwnerKind: endpoint.Owner.Kind, OwnerID: endpoint.Owner.ID,
		Name: endpoint.Name, Enabled: endpoint.Enabled, ConfigVersion: endpoint.ConfigVersion,
		DestinationRevision: endpoint.DestinationRevision, DestinationKind: endpoint.DestinationKind,
		AdapterVersion: endpoint.AdapterVersion, DestinationOrigin: endpoint.DestinationOrigin,
		ActiveKeyID: endpoint.ActiveKeyID, CreatedAt: endpoint.CreatedAt,
		UpdatedAt: endpoint.UpdatedAt, DeletedAt: endpoint.DeletedAt,
	}
}

func metadataBytes(metadata any) (int64, error) {
	data, err := json.Marshal(metadata)
	if err != nil {
		return 0, fmt.Errorf("encode Webhook record metadata: %w", err)
	}
	return int64(len(data)), nil
}

func requireMetadataEnvelope(metadata any) error {
	encodedBytes, err := metadataBytes(metadata)
	if err != nil {
		return err
	}
	if encodedBytes > webhookmodel.DefaultPolicy().RecordEnvelopeBytes {
		return invalid("Webhook record metadata exceeds its 2 KiB storage envelope.")
	}
	return nil
}

// Every non-payload field is represented before charging a fixed record fee.
// Ciphertexts and child records are excluded here and charged separately.
func ValidateConfigurationMetadata(endpoint webhookmodel.Endpoint) error {
	if err := requireMetadataEnvelope(endpointRecordMetadata(endpoint)); err != nil {
		return err
	}
	for _, subscription := range endpoint.Subscriptions {
		metadata := subscriptionMetadata{
			ID: subscription.ID, EndpointID: endpoint.ID, OwnerKind: endpoint.Owner.Kind,
			OwnerID: endpoint.Owner.ID, ProjectID: subscription.ProjectID,
			AuthorizationState: subscription.AuthorizationState, AuthorizationEpoch: subscription.AuthorizationEpoch,
			CreatedAt: metadataTimestamp, UpdatedAt: metadataTimestamp, DeletedAt: subscription.DeletedAt,
		}
		if err := requireMetadataEnvelope(metadata); err != nil {
			return err
		}
		for _, binding := range subscription.Bindings {
			metadata := bindingMetadata{ID: binding.ID, SubscriptionID: subscription.ID, EventType: binding.EventType, CreatedAt: metadataTimestamp, DeletedAt: binding.DeletedAt}
			if err := requireMetadataEnvelope(metadata); err != nil {
				return err
			}
		}
	}
	for _, key := range endpoint.SigningKeys {
		metadata := signingMetadata{ID: key.ID, EndpointID: endpoint.ID, CreatedAt: key.CreatedAt, ExpiresAt: key.ExpiresAt, RevokedAt: key.RevokedAt}
		if err := requireMetadataEnvelope(metadata); err != nil {
			return err
		}
	}
	return nil
}
