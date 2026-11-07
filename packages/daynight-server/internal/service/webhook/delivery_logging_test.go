package webhook

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestDeliveryLogCorrelationExcludesSensitiveMaterial(t *testing.T) {
	var output bytes.Buffer
	r := &Runner{Logger: slog.New(slog.NewJSONHandler(&output, nil))}
	request := "origin-request"
	d := store.WebhookDelivery{ID: "delivery", EventID: "event", EndpointID: "endpoint", ProjectID: "project", Owner: wm.Owner{Kind: "personal", ID: "owner"}, Trigger: "automatic", Generation: 2, DestinationOrigin: "https://secret-host/private-token", Body: []byte("sensitive-payload"), DestinationCiphertext: []byte("secret-key")}
	a := store.WebhookAttempt{ID: "attempt"}
	r.logDelivery(d, &a, &request, "finished", "acknowledged")
	text := output.String()
	for _, required := range []string{"origin-request", "event", "delivery", "attempt", "endpoint", "owner", "project", "automatic", `"generation":2`, "finished"} {
		if !strings.Contains(text, required) {
			t.Fatalf("missing %q in %s", required, text)
		}
	}
	for _, secret := range []string{"secret-host", "private-token", "sensitive-payload", "secret-key"} {
		if strings.Contains(text, secret) {
			t.Fatalf("exposed %q in %s", secret, text)
		}
	}
}
