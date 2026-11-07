package webhook

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func Fingerprint(kind webhookmodel.OperationKind, owner webhookmodel.Owner, endpointID string, normalizedInput any) (string, error) {
	if err := ValidateOwner(owner); err != nil {
		return "", err
	}
	if endpointID != "" {
		if err := canonicalID(endpointID); err != nil {
			return "", err
		}
	}
	switch normalizedInput.(type) {
	case CreateInput:
		if kind != webhookmodel.EndpointCreate || endpointID != "" {
			return "", fmt.Errorf("Webhook creation fingerprint has a conflicting kind or target")
		}
	case PatchInput:
		if kind != webhookmodel.EndpointPatch || endpointID == "" {
			return "", fmt.Errorf("Webhook patch fingerprint has a conflicting kind or target")
		}
	case DeleteInput:
		if kind != webhookmodel.EndpointDelete || endpointID == "" {
			return "", fmt.Errorf("Webhook deletion fingerprint has a conflicting kind or target")
		}
	case RotateInput:
		if kind != webhookmodel.SecretRotate || endpointID == "" {
			return "", fmt.Errorf("Webhook rotation fingerprint has a conflicting kind or target")
		}
	default:
		return "", fmt.Errorf("unsupported Webhook operation fingerprint input")
	}
	data, err := json.Marshal(struct {
		Kind       webhookmodel.OperationKind `json:"kind"`
		Owner      webhookmodel.Owner         `json:"owner"`
		EndpointID string                     `json:"endpointId"`
		Input      any                        `json:"input"`
	}{Kind: kind, Owner: owner, EndpointID: endpointID, Input: normalizedInput})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

// The fixed field order and purpose-specific record identity prevent swapping
// ciphertext between owners, endpoints, signing keys and destination revisions.
func AssociatedData(owner webhookmodel.Owner, endpointID, purpose, recordID string) ([]byte, error) {
	if err := ValidateOwner(owner); err != nil {
		return nil, err
	}
	if err := canonicalID(endpointID); err != nil {
		return nil, err
	}
	switch purpose {
	case "endpoint-current":
		if _, err := ParseVersion(recordID); err != nil {
			return nil, err
		}
	case "delivery-destination", "signing-key":
		if err := canonicalID(recordID); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported Webhook encrypted record purpose")
	}
	return []byte(strings.Join([]string{"daynight.webhook.secretbox.v1", string(owner.Kind), owner.ID, endpointID, purpose, recordID}, "\x00")), nil
}

func EndpointAssociatedData(endpoint webhookmodel.Endpoint) ([]byte, error) {
	return AssociatedData(endpoint.Owner, endpoint.ID, "endpoint-current", strconv.FormatInt(endpoint.DestinationRevision, 10))
}

func SigningAssociatedData(endpoint webhookmodel.Endpoint, keyID string) ([]byte, error) {
	return AssociatedData(endpoint.Owner, endpoint.ID, "signing-key", keyID)
}
