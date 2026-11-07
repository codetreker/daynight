package webhook_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	httpwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identity "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type failedResponseWriter struct {
	header          http.Header
	status          int
	attempted       int
	explicitFailure bool
}

func (w *failedResponseWriter) Header() http.Header    { return w.header }
func (w *failedResponseWriter) WriteHeader(status int) { w.status = status }
func (w *failedResponseWriter) Write(p []byte) (int, error) {
	w.attempted += len(p)
	if w.explicitFailure {
		return 0, errors.New("injected response failure")
	}
	return len(p) - 1, nil
}

// T01-A04: both a short write and an explicit failure occur after the real
// database transaction commits; the operation remains recoverable by its ID.
func TestHTTPCommittedWriteResponseLoss(t *testing.T) {
	for _, tc := range []struct {
		name     string
		explicit bool
	}{{"short_write", false}, {"write_error", true}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHTTPFixture(t)
			actor := f.actor(t)
			master := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
			keys, err := secretbox.Parse([]byte(`{"activeKeyId":"main","keys":{"main":"` + master + `"}}`))
			if err != nil {
				t.Fatal(err)
			}
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			id := identity.New(f.db, nil, testOrigin+"/auth/callback")
			authenticator, err := auth.NewAuthentication(id, config.AuthSettings{PublicOrigin: testOrigin, AllowHTTPTestOrigin: true}, logger)
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			httpwebhook.RegisterRoutes(mux, httpwebhook.Adapter{Service: &service.Service{DB: f.db, Keys: keys}}, authenticator, logger)
			destination := "https://receiver.example/private-path?token=private-query"
			fields := createFields(actor, "response-loss", destination)
			body := encoded(t, fields)
			op := fields["operationId"].(string)
			req := httptest.NewRequest("POST", "/api/v1/me/webhooks", strings.NewReader(body))
			req.AddCookie(&http.Cookie{Name: "daynight_session", Value: actor.cookie})
			req.Header.Set("Origin", testOrigin)
			req.Header.Set("Content-Type", "application/json")
			writer := &failedResponseWriter{header: make(http.Header), explicitFailure: tc.explicit}
			mux.ServeHTTP(writer, req)
			if writer.status != http.StatusCreated || writer.attempted == 0 {
				t.Fatalf("response did not reach failing writer: status=%d attempted=%d", writer.status, writer.attempted)
			}
			if writer.Header().Get("Cache-Control") != "no-store" || writer.Header().Get("Daynight-User-ID") != actor.id {
				t.Fatalf("identity/cache headers: %v", writer.Header())
			}
			var endpoints, receipts int
			var hash, target string
			err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1),request_sha256,target_id::text FROM webhook_operations WHERE owner_id=$1 AND operation_id=$2`, actor.id, op).Scan(&endpoints, &receipts, &hash, &target)
			sum := sha256.Sum256([]byte(body))
			expected := hex.EncodeToString(sum[:])
			if err != nil || endpoints != 1 || receipts != 1 || hash != expected {
				t.Fatalf("effect endpoints=%d receipts=%d hash=%s err=%v", endpoints, receipts, hash, err)
			}
			status, _, receipt := f.request(t, actor, "GET", "/api/v1/me/webhooks/operations/"+op, "")
			mustStatus(t, status, 200, receipt)
			read := jsonBody(t, receipt)
			if read["requestSha256"] != expected || read["endpointId"] != target {
				t.Fatalf("receipt did not recover original effect: %s", receipt)
			}
			status, _, secretBody := f.request(t, actor, "GET", "/api/v1/me/webhooks/"+target+"/signing-secret", "")
			mustStatus(t, status, 200, secretBody)
			var secret struct {
				Secret string `json:"secret"`
			}
			if err = json.Unmarshal(secretBody, &secret); err != nil || !strings.HasPrefix(secret.Secret, "whsec_") {
				t.Fatalf("secret unavailable: %v", err)
			}
			output := logs.String()
			if !strings.Contains(output, "write_outcome_unknown") || !strings.Contains(output, `"write_outcome":"unknown"`) {
				t.Fatalf("missing unknown outcome diagnostic: %s", output)
			}
			for _, private := range []struct{ label, value string }{{"destination", destination}, {"path", "private-path"}, {"query", "private-query"}, {"secret", secret.Secret}, {"secret prefix", "whsec_"}} {
				if strings.Contains(output, private.value) {
					t.Fatalf("diagnostic exposed %s", private.label)
				}
			}
		})
	}
}
