package webhook

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

func encryptedEnvelope(data []byte) (secretbox.Envelope, error) {
	if !jsonunicode.Valid(data) {
		return secretbox.Envelope{}, fmt.Errorf("encrypted Webhook record has invalid Unicode")
	}
	fields, err := jsonobject.Decode(data, "encrypted Webhook record", "version", "masterKeyId", "nonce", "ciphertext")
	if err != nil || len(fields) != 4 {
		return secretbox.Envelope{}, fmt.Errorf("encrypted Webhook envelope is invalid: %w", secretbox.ErrEnvelopeInvalid)
	}
	var envelope secretbox.Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return secretbox.Envelope{}, fmt.Errorf("decode encrypted Webhook envelope: %w", err)
	}
	return envelope, nil
}

func (s *Manager) decrypt(data, associatedData []byte) ([]byte, error) {
	envelope, err := encryptedEnvelope(data)
	if err != nil {
		return nil, err
	}
	return s.keys.Open(envelope, associatedData)
}

func (s *Manager) encrypt(data, associatedData []byte) ([]byte, error) {
	envelope, err := s.keys.Seal(data, associatedData)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope)
}

func (s *Manager) destination(endpoint webhookmodel.Endpoint) (webhookmodel.Destination, error) {
	aad, err := webhookcore.EndpointAssociatedData(endpoint)
	if err != nil {
		return webhookmodel.Destination{}, err
	}
	data, err := s.decrypt(endpoint.EncryptedDestination, aad)
	if err != nil {
		return webhookmodel.Destination{}, err
	}
	defer clear(data)
	fields, err := jsonobject.Decode(data, "stored destination", "kind", "adapterVersion", "configuration")
	if err != nil || len(fields) != 3 {
		return webhookmodel.Destination{}, fmt.Errorf("stored destination is invalid")
	}
	configuration, err := jsonobject.Decode(fields["configuration"], "stored destination configuration", "url")
	if err != nil || len(configuration) != 1 {
		return webhookmodel.Destination{}, fmt.Errorf("stored destination configuration is invalid")
	}
	var destination webhookmodel.Destination
	if err := json.Unmarshal(data, &destination); err != nil {
		return webhookmodel.Destination{}, fmt.Errorf("decode stored destination: %w", err)
	}
	if err := webhookcore.ValidateDestination(destination); err != nil {
		return webhookmodel.Destination{}, &model.Fault{Code: "internal_error", Message: "Stored Webhook destination violates its schema.", Cause: err}
	}
	origin, err := webhookcore.DestinationOrigin(destination)
	if err != nil || destination.Kind != endpoint.DestinationKind || destination.AdapterVersion != endpoint.AdapterVersion || origin != endpoint.DestinationOrigin {
		return webhookmodel.Destination{}, fmt.Errorf("stored destination metadata is inconsistent")
	}
	return destination, nil
}

func (s *Manager) signingSecret(endpoint webhookmodel.Endpoint, key webhookmodel.SigningKey) ([]byte, error) {
	aad, err := webhookcore.SigningAssociatedData(endpoint, key.ID)
	if err != nil {
		return nil, err
	}
	data, err := s.decrypt(key.EncryptedSecret, aad)
	if err != nil {
		return nil, err
	}
	if len(data) != 32 {
		clear(data)
		return nil, fmt.Errorf("stored signing secret has an invalid length")
	}
	return data, nil
}

func (s *Manager) completeEncryptedMutation(prepared *webhookcore.PreparedMutation) error {
	endpoint := &prepared.Endpoint
	if !prepared.Changed || endpoint.DeletedAt != nil {
		return nil
	}
	// Saving configuration rewrites retained encrypted rows. Each new write
	// uses this runtime's active master while preserving decoded key identities.
	if prepared.Destination == nil {
		destination, err := s.destination(*endpoint)
		if err != nil {
			return err
		}
		prepared.Destination = &destination
	}
	if prepared.Destination != nil {
		data, err := json.Marshal(*prepared.Destination)
		if err != nil {
			return err
		}
		defer clear(data)
		aad, err := webhookcore.EndpointAssociatedData(*endpoint)
		if err != nil {
			return err
		}
		endpoint.EncryptedDestination, err = s.encrypt(data, aad)
		if err != nil {
			return err
		}
	}
	for i := range endpoint.SigningKeys {
		key := &endpoint.SigningKeys[i]
		var data []byte
		if key.ID == prepared.NewSigningKeyID {
			data = make([]byte, 32)
			if _, err := rand.Read(data); err != nil {
				return fmt.Errorf("generate signing secret: %w", err)
			}
		} else {
			var err error
			data, err = s.signingSecret(*endpoint, *key)
			if err != nil {
				return err
			}
		}
		aad, err := webhookcore.SigningAssociatedData(*endpoint, key.ID)
		if err != nil {
			clear(data)
			return err
		}
		encrypted, err := s.encrypt(data, aad)
		clear(data)
		if err != nil {
			return err
		}
		key.EncryptedSecret = encrypted
	}
	return nil
}

func secretText(data []byte) string {
	return "whsec_" + base64.StdEncoding.EncodeToString(data)
}
