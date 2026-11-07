package webhook

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type advancedAdmissionClock struct{ *postgres.Store }
type advancingWriteScope struct {
	store.WebhookWriteScope
	observations int
}

func (s *advancingWriteScope) ObservedAt(ctx context.Context) (time.Time, error) {
	now, err := s.WebhookWriteScope.ObservedAt(ctx)
	s.observations++
	if s.observations > 1 {
		now = now.Add(6 * time.Minute)
	}
	return now, err
}

func (d advancedAdmissionClock) WriteWebhook(ctx context.Context, owner webhookmodel.Owner, id string, callback func(store.WebhookWriteScope) error) (store.Completion, error) {
	return d.Store.WriteWebhook(ctx, owner, id, func(scope store.WebhookWriteScope) error {
		return callback(&advancingWriteScope{WebhookWriteScope: scope})
	})
}

func TestNewOperationRechecksFreshnessAfterSourceAdmission(t *testing.T) {
	h := newIntegrationHarness(t)
	h.mount(t, advancedAdmissionClock{Store: h.Database}, h.keyring, true)
	response := h.call("POST", "/api/v1/me/webhooks", body(t, createBody(h, h.alice)), h.aliceCookie)
	errorStatus(t, response, 410, "operation_expired")
	var endpoints, operations int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations)`).Scan(&endpoints, &operations); err != nil || endpoints != 0 || operations != 0 {
		t.Fatal("source admission delay applied an expired operation")
	}
}

func TestOversizedStoredMetadataRollsBackConfigurationAndReceiptReservation(t *testing.T) {
	h := newIntegrationHarness(t)
	input := createBody(h, h.alice)
	input["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://" + strings.Repeat("a", 2030) + ".example/events"}}
	errorStatus(t, h.call("POST", "/api/v1/me/webhooks", body(t, input), h.aliceCookie), 400, "invalid_input")
	var endpoints, operations int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations)`).Scan(&endpoints, &operations); err != nil || endpoints != 0 || operations != 0 {
		t.Fatal("metadata refusal left configuration or operation effects")
	}
}

func TestDeletionClearsUnreadableEncryptedStateWithoutDecrypting(t *testing.T) {
	h := newIntegrationHarness(t)
	created := decoded[mutationResponse](t, h.call("POST", "/api/v1/me/webhooks", body(t, createBody(h, h.alice)), h.aliceCookie), 201)
	endpoint := decodeEndpoint(t, created.Endpoint)
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE webhook_endpoints SET encrypted_destination=$2 WHERE id=$1`, endpoint.ID, []byte(`not an encrypted envelope`)); err != nil {
		t.Fatal(err)
	}
	remove := h.newOperation(h.alice)
	remove["ifVersion"] = endpoint.ConfigVersion
	deleted := decoded[mutationResponse](t, h.call("DELETE", "/api/v1/me/webhooks/"+endpoint.ID, body(t, remove), h.aliceCookie), 200)
	if deleted.Operation.ConfigVersionAfter != "2" {
		t.Fatal("cleanup required decrypting state that it only clears")
	}
}
