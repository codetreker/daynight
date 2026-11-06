package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	serveroauth "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth"
)

type fakeMetadata struct {
	data   []byte
	called int
}

func (f *fakeMetadata) Fetch(_ context.Context, _ string, validate func([]byte) error) ([]byte, time.Time, error) {
	f.called++
	if err := validate(f.data); err != nil {
		return nil, time.Time{}, err
	}
	return f.data, time.Now().Add(time.Hour), nil
}

func TestClientsRegistrationAndResolution(t *testing.T) {
	ctx := context.Background()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	admission := core.PublicAdmission{Writer: db}
	prereg := []byte(`{"client_id":"known","redirect_uris":["https://client.example/cb"]}`)
	clients, err := NewClients(db, admission, map[string][]byte{"known": prereg})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewClients(db, admission, map[string][]byte{"wrong": prereg}); err == nil {
		t.Fatal("invalid configured client accepted")
	}
	doc := []byte(`{"client_name":"client","redirect_uris":["http://127.0.0.1:123/cb"],"logo_uri":"https://client.example/logo","software_id":"sample","extension":{"value":true}}`)
	server := httptest.NewServer(serveroauth.Handler(clients))
	t.Cleanup(server.Close)
	resp, err := http.Post(server.URL, "application/json", bytes.NewReader(doc))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var registered core.ClientMetadata
	var returned map[string]json.RawMessage
	if err := json.Unmarshal(body, &registered); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &returned); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"logo_uri", "software_id", "extension", "client_secret"} {
		if _, exists := returned[key]; exists {
			t.Fatalf("unexpected registration response field %s", key)
		}
	}
	if resp.StatusCode != http.StatusCreated || registered.TokenEndpointAuthMethod != "none" {
		t.Fatalf("HTTP register: %d %+v", resp.StatusCode, registered)
	}
	for _, raw := range []string{
		`{"redirect_uris":["https://client.example/cb"],"extension":true,"extension":false}`,
		`{"redirect_uris":["https://client.example/cb"],"client_id":"supplied"}`,
		`{"redirect_uris":["https://client.example/cb"],"client_secret":"supplied"}`,
		`{"redirect_uris":["https://client.example/cb"],"token_endpoint_auth_method":"client_secret_basic"}`,
		`{"redirect_uris":["https://client.example/cb"],"grant_types":["client_credentials"]}`,
		`{"redirect_uris":["https://client.example/cb"],"scope":"other"}`,
		`{"redirect_uris":["https://client.example/cb"],"response_types":["token"]}`,
	} {
		response, err := http.Post(server.URL, "application/json", strings.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		var failure struct {
			Error string `json:"error"`
		}
		err = json.NewDecoder(response.Body).Decode(&failure)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusBadRequest || failure.Error != "invalid_client_metadata" {
			t.Fatalf("invalid registration %s: %d %+v %v", raw, response.StatusCode, failure, err)
		}
	}
	if _, err := clients.Resolve(ctx, registered.ClientID, "http://127.0.0.1:456/cb"); err != nil {
		t.Fatalf("HTTP client resolve: %v", err)
	}
	for _, id := range []string{"", "bad\x00id", string([]byte{0xff})} {
		if _, err := clients.Resolve(ctx, id, "http://127.0.0.1:456/cb"); !errors.Is(err, core.ErrInvalidClient) {
			t.Fatalf("bad id: %v", err)
		}
	}
	m, err := clients.Register(ctx, "registration", doc)
	if err != nil || m.ClientID == "" || m.TokenEndpointAuthMethod != "none" {
		t.Fatalf("register: %+v %v", m, err)
	}
	largeRedirect := "https://client.example/" + strings.Repeat("a", core.MetadataLimit-100)
	large := []byte(`{"redirect_uris":["` + largeRedirect + `"]}`)
	largeClient, err := clients.Register(ctx, "large", large)
	if err != nil {
		t.Fatalf("large registration: %v", err)
	}
	if _, err := clients.Resolve(ctx, largeClient.ClientID, largeRedirect); err != nil {
		t.Fatalf("large registration could not resolve: %v", err)
	}
	snapshot, err := clients.Resolve(ctx, m.ClientID, "http://127.0.0.1:456/cb")
	if err != nil || snapshot.Provenance != "dcr" || snapshot.SelectedExactRedirect != "http://127.0.0.1:456/cb" {
		t.Fatalf("resolve: %+v %v", snapshot, err)
	}
	if _, err := clients.Resolve(ctx, m.ClientID, "https://attacker.example/cb"); !errors.Is(err, core.ErrInvalidClient) {
		t.Fatalf("wrong redirect: %v", err)
	}
	snapshot, err = clients.Resolve(ctx, "known", "https://client.example/cb")
	if err != nil || snapshot.Provenance != "preregistered" {
		t.Fatalf("configured: %+v %v", snapshot, err)
	}
	fetch := &fakeMetadata{data: []byte(`{"client_id":"https://client.example/meta","redirect_uris":["https://client.example/cb"]}`)}
	clients.fetch = fetch
	snapshot, err = clients.Resolve(ctx, "https://client.example/meta", "https://client.example/cb")
	if err != nil || snapshot.Provenance != "cimd" || snapshot.MetadataDeadline.IsZero() {
		t.Fatalf("CIMD: %+v %v", snapshot, err)
	}
	if _, err := clients.Resolve(ctx, "https://wrong.example/meta", "https://client.example/cb"); !errors.Is(err, core.ErrInvalidClient) {
		t.Fatalf("identity mismatch: %v", err)
	}
	if _, err := clients.Register(ctx, "bad", []byte(`{"redirect_uris":[],"token_endpoint_auth_method":"client_secret_basic"}`)); !errors.Is(err, core.ErrInvalidClientMetadata) {
		t.Fatalf("invalid registration: %v", err)
	}
	for i := 0; i < 10; i++ {
		if _, err := clients.Register(ctx, "limited", []byte(`{}`)); !errors.Is(err, core.ErrInvalidClientMetadata) {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if _, err := clients.Register(ctx, "limited", doc); !errors.Is(err, core.ErrRateLimited) {
		t.Fatalf("budget: %v", err)
	}
}
