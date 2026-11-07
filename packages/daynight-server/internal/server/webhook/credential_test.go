package webhook

import (
	"context"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type revokeBeforeWrite struct {
	*postgres.Store
	credentialID string
}

func (s *revokeBeforeWrite) WriteWebhook(ctx context.Context, owner webhookmodel.Owner, operationID string, callback func(store.WebhookWriteScope) error) (store.Completion, error) {
	if _, err := s.Pool.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, s.credentialID); err != nil {
		return store.Completion{}, err
	}
	return s.Store.WriteWebhook(ctx, owner, operationID, callback)
}

func TestWriteTransactionRevalidatesCredentialAfterHTTPAuthentication(t *testing.T) {
	for _, replay := range []bool{false, true} {
		t.Run(map[bool]string{false: "new effect", true: "receipt replay"}[replay], func(t *testing.T) {
			h := newIntegrationHarness(t)
			input := createBody(h, h.alice)
			requestBody := body(t, input)
			var original mutationResponse
			if replay {
				original = decoded[mutationResponse](t, h.call("POST", "/api/v1/me/webhooks", requestBody, h.aliceCookie), http.StatusCreated)
			}
			cookie := h.Login(t, "webhook-alice")
			principal := h.principal(t, cookie)
			h.mount(t, &revokeBeforeWrite{Store: h.Database, credentialID: principal.CredentialID}, h.keyring, true)
			errorStatus(t, h.call("POST", "/api/v1/me/webhooks", requestBody, cookie), http.StatusUnauthorized, "unauthenticated")
			var count int
			if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_endpoints`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if !replay && count != 0 || replay && count != 1 {
				t.Fatal("credential revoked after HTTP authentication applied a new effect")
			}
			if replay {
				h.mount(t, h.Database, h.keyring, true)
				observed := decoded[operationResponse](t, h.call("GET", "/api/v1/me/webhooks/operations/"+original.Operation.OperationID, "", h.aliceCookie), http.StatusOK)
				if observed.EndpointID != original.Operation.EndpointID {
					t.Fatal("credential refusal changed the previously committed receipt")
				}
			}
		})
	}
}
