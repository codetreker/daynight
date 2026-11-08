package webhook_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOperationHTTPLogicalExpiryBeforeCollection(t *testing.T) {
	for _, kind := range []string{"management", "redelivery"} {
		t.Run(kind, func(t *testing.T) {
			r := newRetentionHTTP(t, false)
			operationID := uuid.NewString()
			method, path := http.MethodPatch, "/api/v1/me/webhooks/"+r.endpoint
			input := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"1","name":"renamed"}`, operationID, time.Now().UTC().Format(time.RFC3339Nano), r.f.principal.UserID)
			if kind == "redelivery" {
				method = http.MethodPost
				path += "/deliveries/" + r.delivery + "/redeliveries"
				input = r.intent()
				var intent struct{ OperationID string }
				if err := json.Unmarshal([]byte(input), &intent); err != nil {
					t.Fatal(err)
				}
				operationID = intent.OperationID
			}
			call := func(method, path, body string, status int, code string) []byte {
				t.Helper()
				req, err := http.NewRequestWithContext(r.f.ctx, method, r.host.URL+path, strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: r.token})
				req.Header.Set("Origin", "https://daynight.example")
				req.Header.Set("Content-Type", "application/json")
				response, err := r.host.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				bytes, err := io.ReadAll(response.Body)
				if err != nil || response.StatusCode != status || code != "" && !strings.Contains(string(bytes), `"code":"`+code+`"`) {
					t.Fatalf("%s %s: status=%d body=%s err=%v", method, path, response.StatusCode, bytes, err)
				}
				if response.Header.Get("Daynight-User-ID") != r.f.principal.UserID || response.Header.Get("Cache-Control") != "no-store" {
					t.Fatal("missing authenticated no-store response headers")
				}
				return bytes
			}
			success := http.StatusOK
			if kind == "redelivery" {
				success = http.StatusAccepted
			}
			call(method, path, input, success, "")
			operationPath := "/api/v1/me/webhooks/operations/" + operationID
			call(http.MethodGet, operationPath, "", http.StatusOK, "")
			// The same intent precedes stale configuration/generation admission.
			call(method, path, input, success, "")
			if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_operations SET recorded_at=recorded_at-interval '31 days',expires_at=expires_at-interval '31 days' WHERE operation_id=$1`, operationID); err != nil {
				t.Fatal(err)
			}
			var version, generation, ticket int64
			var manual int
			if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT e.config_version,d.generation,d.manual_operation_count,d.queue_order FROM webhook_endpoints e JOIN webhook_deliveries d ON d.endpoint_id=e.id WHERE d.id=$1`, r.delivery).Scan(&version, &generation, &manual, &ticket); err != nil {
				t.Fatal(err)
			}
			call(http.MethodGet, operationPath, "", http.StatusNotFound, "not_found")
			call(method, path, input, http.StatusGone, "operation_expired")
			conflictingInput := strings.Replace(input, `"name":"renamed"`, `"name":"other"`, 1)
			if kind == "redelivery" {
				conflictingInput = strings.Replace(input, `"ifGeneration":"1"`, `"ifGeneration":"2"`, 1)
			}
			call(method, path, conflictingInput, http.StatusConflict, "operation_conflict")
			var afterVersion, afterGeneration, afterTicket int64
			var afterManual, receipts int
			if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT e.config_version,d.generation,d.manual_operation_count,d.queue_order,(SELECT count(*) FROM webhook_operations WHERE operation_id=$2) FROM webhook_endpoints e JOIN webhook_deliveries d ON d.endpoint_id=e.id WHERE d.id=$1`, r.delivery, operationID).Scan(&afterVersion, &afterGeneration, &afterManual, &afterTicket, &receipts); err != nil || version != afterVersion || generation != afterGeneration || manual != afterManual || ticket != afterTicket || receipts != 1 {
				t.Fatalf("expired replay changed effects or removed identity: version=%d generation=%d manual=%d ticket=%d receipts=%d err=%v", afterVersion, afterGeneration, afterManual, afterTicket, receipts, err)
			}
		})
	}
}
