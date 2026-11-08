package webhook

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
	f := newFixture(t, true)
	if _, err := f.svc.Catalog(f.ctx, model.Principal{}); err == nil {
		t.Fatal("invalid principal accepted")
	}
	principal := f.principal(t)
	if _, err := f.svc.Catalog(f.ctx, principal); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_policies WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Catalog(f.ctx, principal); err == nil {
		t.Fatal("missing policy accepted")
	}
	if _, err := f.db.Pool.Exec(f.ctx, `DELETE FROM sessions WHERE id=$1`, principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Catalog(f.ctx, principal); err == nil || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked credential: %v", err)
	}
}
