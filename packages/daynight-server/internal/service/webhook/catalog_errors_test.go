package webhook

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestDestinationDocumentValidation(t *testing.T) {
	destination := Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.test/Case?token=X"}
	data, err := encodeDestination(destination)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := decodeDestination(data)
	if err != nil || actual != destination {
		t.Fatalf("round trip: %+v %v", actual, err)
	}
	if _, err := encodeDestination(Destination{Kind: "http", AdapterVersion: "1", URL: strings.Repeat("x", 256*1024)}); err == nil {
		t.Fatal("oversized encoded document accepted")
	}
	for _, input := range []string{`{`, `{"kind":"other","adapterVersion":"1","configuration":{"url":"https://example.test/"}}`, `{"kind":"http","adapterVersion":"1","configuration":{"url":"http://example.test/"}}`} {
		if _, err := decodeDestination([]byte(input)); err == nil {
			t.Fatalf("accepted invalid stored destination %q", input)
		}
	}
}

func TestCatalogRejectsInvalidCredentialAndMissingPolicy(t *testing.T) {
	for _, kind := range []string{"invalid principal", "revoked credential", "missing policy", "snapshot failure", "success"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			cause := errors.New("policy unavailable")
			f.preDAO.PolicyFn = func(_ context.Context, v int64) (wm.Policy, error) {
				if v != 1 {
					t.Errorf("catalog policy=%d", v)
				}
				return f.policy, nil
			}
			principal := f.principal
			switch kind {
			case "invalid principal":
				principal = model.Principal{}
			case "revoked credential":
				f.preCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, model.ErrNotFound
				}
			case "missing policy":
				f.preDAO.PolicyFn = func(context.Context, int64) (wm.Policy, error) { return wm.Policy{}, cause }
			case "snapshot failure":
				f.db.ReadFn = func(context.Context, func(store.WebhookReadScope) error) error { return cause }
			}
			value, err := f.service.Catalog(f.ctx, principal)
			switch kind {
			case "invalid principal":
				if err == nil || len(f.trace.snapshot()) != 0 {
					t.Fatalf("invalid catalog=%#v %v", value, err)
				}
			case "revoked credential":
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("revoked cause=%v", err)
				}
			case "missing policy", "snapshot failure":
				if !errors.Is(err, cause) {
					t.Fatalf("lost catalog cause=%v", err)
				}
			case "success":
				if err != nil {
					t.Fatal(err)
				}
				v := value.(map[string]any)
				if len(v["items"].([]any)) != 6 || v["limits"].(map[string]any)["policyVersion"] != "1" {
					t.Fatalf("catalog=%#v", v)
				}
			}
		})
	}
}
