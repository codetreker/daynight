package webhook

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

const (
	boundaryUserID         = "11111111-1111-4111-8111-111111111111"
	boundaryCredentialID   = "22222222-2222-4222-8222-222222222222"
	boundaryEndpointID     = "33333333-3333-4333-8333-333333333333"
	boundaryKeyID          = "44444444-4444-4444-8444-444444444444"
	boundarySubscriptionID = "55555555-5555-4555-8555-555555555555"
	boundaryProjectID      = "66666666-6666-4666-8666-666666666666"
	boundaryBindingID      = "77777777-7777-4777-8777-777777777777"
	boundaryOperationID    = "88888888-8888-4888-8888-888888888888"
)

var boundaryNow = time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)

func boundaryKeyring(t *testing.T, active string, keys map[string][]byte) *secretbox.Keyring {
	t.Helper()
	encoded := make(map[string]string, len(keys))
	for id, key := range keys {
		encoded[id] = base64.StdEncoding.EncodeToString(key)
	}
	data, err := json.Marshal(map[string]any{"activeKeyId": active, "keys": encoded})
	if err != nil {
		t.Fatal(err)
	}
	ring, err := secretbox.New(data)
	if err != nil {
		t.Fatal(err)
	}
	return ring
}

func boundaryCrypto(t *testing.T) (*Manager, webhookmodel.Endpoint, webhookmodel.Destination) {
	t.Helper()
	manager := &Manager{keys: boundaryKeyring(t, "old", map[string][]byte{"old": bytes.Repeat([]byte{1}, 32)})}
	destination := webhookmodel.Destination{Kind: "http", AdapterVersion: 1, Configuration: webhookmodel.HTTPConfiguration{URL: "https://receiver.example/private?token=never-disclose"}}
	endpoint := webhookmodel.Endpoint{ID: boundaryEndpointID, Owner: webhookmodel.Owner{Kind: webhookmodel.PersonalOwner, ID: boundaryUserID}, Name: "Release", Enabled: true,
		ConfigVersion: 3, DestinationRevision: 2, DestinationKind: "http", AdapterVersion: 1, DestinationOrigin: "https://receiver.example", ActiveKeyID: boundaryKeyID,
		CreatedAt: boundaryNow, UpdatedAt: boundaryNow, SigningKeys: []webhookmodel.SigningKey{{ID: boundaryKeyID, CreatedAt: boundaryNow}},
		Subscriptions: []webhookmodel.Subscription{{ID: boundarySubscriptionID, ProjectID: boundaryProjectID, AuthorizationState: webhookmodel.AuthorizationActive, AuthorizationEpoch: 1, Bindings: []webhookmodel.Binding{{ID: boundaryBindingID, EventType: "task.paused"}}}}}
	endpoint.EncryptedDestination = boundarySealDestination(t, manager, endpoint, destination)
	aad, err := webhookcore.SigningAssociatedData(endpoint, boundaryKeyID)
	if err != nil {
		t.Fatal(err)
	}
	endpoint.SigningKeys[0].EncryptedSecret, err = manager.encrypt(bytes.Repeat([]byte{2}, 32), aad)
	if err != nil {
		t.Fatal(err)
	}
	return manager, endpoint, destination
}

func boundarySealDestination(t *testing.T, manager *Manager, endpoint webhookmodel.Endpoint, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	aad, err := webhookcore.EndpointAssociatedData(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := manager.encrypt(data, aad)
	if err != nil {
		t.Fatal(err)
	}
	return encrypted
}

func TestEncryptedStoredRecordsRejectCorruptionWithoutPlaintextFallback(t *testing.T) {
	manager, original, destination := boundaryCrypto(t)
	decoded, err := manager.destination(original)
	if err != nil || decoded != destination {
		t.Fatalf("valid stored destination: %+v %v", decoded, err)
	}
	for _, data := range [][]byte{[]byte{0xff}, []byte(`{}`), []byte(`{"version":1,"masterKeyId":"old","nonce":"","ciphertext":"","extra":1}`), []byte(`{"version":"1","masterKeyId":"old","nonce":"","ciphertext":""}`)} {
		endpoint := original
		endpoint.EncryptedDestination = data
		value, err := manager.destination(endpoint)
		if err == nil || value.Configuration.URL != "" || strings.Contains(err.Error(), "never-disclose") {
			t.Fatal("corrupt encrypted record was accepted or exposed")
		}
	}
	wrongRevision := original
	wrongRevision.DestinationRevision++
	if _, err := manager.destination(wrongRevision); !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("revision swap: %v", err)
	}
	missingKey := &Manager{keys: boundaryKeyring(t, "new", map[string][]byte{"new": bytes.Repeat([]byte{3}, 32)})}
	if _, err := missingKey.destination(original); !errors.Is(err, secretbox.ErrKeyUnavailable) {
		t.Fatalf("missing master did not preserve key failure: %v", err)
	}
	wrongOwner := original
	wrongOwner.Owner.Kind = "invalid"
	if _, err := manager.destination(wrongOwner); err == nil {
		t.Fatal("invalid owner context was accepted")
	}
	for _, value := range []any{
		map[string]any{"kind": "http", "adapterVersion": 1},
		map[string]any{"kind": "http", "adapterVersion": 1, "configuration": map[string]any{"url": destination.Configuration.URL, "secret": "never-disclose"}},
		map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": destination.Configuration.URL}},
		webhookmodel.Destination{Kind: "unsupported", AdapterVersion: 1, Configuration: destination.Configuration},
		webhookmodel.Destination{Kind: "http", AdapterVersion: 1, Configuration: webhookmodel.HTTPConfiguration{URL: "https://other.example/events"}},
	} {
		endpoint := original
		endpoint.EncryptedDestination = boundarySealDestination(t, manager, endpoint, value)
		_, err := manager.destination(endpoint)
		if err == nil || strings.Contains(err.Error(), "never-disclose") {
			t.Fatal("authenticated but invalid stored destination was treated as usable")
		}
	}
	invalidStored := original
	invalidStored.EncryptedDestination = boundarySealDestination(t, manager, invalidStored, webhookmodel.Destination{Kind: "unsupported", AdapterVersion: 1, Configuration: destination.Configuration})
	_, err = manager.destination(invalidStored)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "internal_error" || fault.Cause == nil {
		t.Fatal("stored schema failure was mislabeled as caller input or lost its cause")
	}
}

func TestSigningRecordsPreserveAuthenticationAndLengthFailures(t *testing.T) {
	manager, endpoint, _ := boundaryCrypto(t)
	key := endpoint.SigningKeys[0]
	data, err := manager.signingSecret(endpoint, key)
	if err != nil || !bytes.Equal(data, bytes.Repeat([]byte{2}, 32)) {
		t.Fatalf("signing secret: %v", err)
	}
	if secretText(data) != "whsec_"+base64.StdEncoding.EncodeToString(data) {
		t.Fatal("signing export changed exact key bytes")
	}
	other := key
	other.ID = boundaryOperationID
	if _, err := manager.signingSecret(endpoint, other); !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("key identity swap: %v", err)
	}
	other = key
	other.ID = "invalid"
	if _, err := manager.signingSecret(endpoint, other); err == nil {
		t.Fatal("invalid signing record identity accepted")
	}
	aad, err := webhookcore.SigningAssociatedData(endpoint, key.ID)
	if err != nil {
		t.Fatal(err)
	}
	other = key
	other.EncryptedSecret, err = manager.encrypt(bytes.Repeat([]byte{2}, 31), aad)
	if err != nil {
		t.Fatal(err)
	}
	if data, err := manager.signingSecret(endpoint, other); err == nil || len(data) != 0 {
		t.Fatal("invalid decrypted signing length was exported")
	}
	other = key
	other.EncryptedSecret = []byte(`{}`)
	if _, err := manager.signingSecret(endpoint, other); !errors.Is(err, secretbox.ErrEnvelopeInvalid) {
		t.Fatalf("invalid signing envelope: %v", err)
	}
}

func TestChangedConfigurationRewrapsRetainedRecordsButNoopAndDeleteDoNotDecrypt(t *testing.T) {
	old, endpoint, destination := boundaryCrypto(t)
	manager := &Manager{keys: boundaryKeyring(t, "new", map[string][]byte{"old": bytes.Repeat([]byte{1}, 32), "new": bytes.Repeat([]byte{3}, 32)})}
	prepared := webhookcore.PreparedMutation{Endpoint: endpoint, Changed: true}
	if err := manager.completeEncryptedMutation(&prepared); err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{prepared.Endpoint.EncryptedDestination, prepared.Endpoint.SigningKeys[0].EncryptedSecret} {
		envelope, err := encryptedEnvelope(data)
		if err != nil || envelope.MasterKeyID != "new" {
			t.Fatal("configuration write retained old master reference")
		}
	}
	decoded, err := manager.destination(prepared.Endpoint)
	if err != nil || decoded != destination || prepared.Endpoint.ActiveKeyID != endpoint.ActiveKeyID {
		t.Fatal("rewrap changed decoded destination or signing identity")
	}
	secret, err := manager.signingSecret(prepared.Endpoint, prepared.Endpoint.SigningKeys[0])
	if err != nil || !bytes.Equal(secret, bytes.Repeat([]byte{2}, 32)) {
		t.Fatal("rewrap changed retained secret")
	}
	for _, deleted := range []bool{false, true} {
		bad := webhookcore.PreparedMutation{Endpoint: endpoint, Changed: deleted}
		bad.Endpoint.EncryptedDestination = []byte("corrupt")
		if deleted {
			now := boundaryNow
			bad.Endpoint.DeletedAt = &now
		}
		if err := (&Manager{}).completeEncryptedMutation(&bad); err != nil || string(bad.Endpoint.EncryptedDestination) != "corrupt" {
			t.Fatal("no-op or cleanup needed decryption")
		}
	}
	broken := webhookcore.PreparedMutation{Endpoint: endpoint, Changed: true}
	broken.Endpoint.EncryptedDestination = []byte("corrupt")
	if err := manager.completeEncryptedMutation(&broken); err == nil {
		t.Fatal("changed configuration hid destination corruption")
	}
	broken = webhookcore.PreparedMutation{Endpoint: endpoint, Destination: &destination, Changed: true}
	broken.Endpoint.SigningKeys = []webhookmodel.SigningKey{{ID: boundaryKeyID, EncryptedSecret: []byte("corrupt")}}
	if err := manager.completeEncryptedMutation(&broken); err == nil {
		t.Fatal("changed configuration regenerated an existing corrupt secret")
	}
	newKey := webhookmodel.SigningKey{ID: boundaryOperationID, CreatedAt: boundaryNow}
	created := webhookcore.PreparedMutation{Endpoint: endpoint, Destination: &destination, Changed: true, NewSigningKeyID: newKey.ID}
	created.Endpoint.ActiveKeyID = newKey.ID
	created.Endpoint.SigningKeys = []webhookmodel.SigningKey{newKey}
	if err := old.completeEncryptedMutation(&created); err != nil {
		t.Fatal(err)
	}
	if secret, err := old.signingSecret(created.Endpoint, created.Endpoint.SigningKeys[0]); err != nil || len(secret) != 32 {
		t.Fatal("new key was not generated as a recoverable secret")
	}
}
