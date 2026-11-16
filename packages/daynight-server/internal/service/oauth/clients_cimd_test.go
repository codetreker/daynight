package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestClientsResolvePublicCIMDThroughTLSAndCache(t *testing.T) {
	for _, tc := range []struct {
		file, redirect string
	}{
		{"claude.json", "http://localhost:49416/callback"},
		{"copilot.json", "http://127.0.0.1:456/callback"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "oauth", tc.file))
			if err != nil {
				t.Fatal(err)
			}
			var public struct { ClientID string `json:"client_id"` }
			if err := json.Unmarshal(raw, &public); err != nil {
				t.Fatal(err)
			}
			const id = "https://example.com/client"
			// Only the identity changes to the TLS fixture's certified hostname.
			raw = []byte(strings.Replace(string(raw), public.ClientID, id, 1))
			fetch, _, dials := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Host != "example.com" || r.TLS == nil || r.TLS.ServerName != "example.com" || r.URL.Path != "/client" {
					t.Error("CIMD request lost its original TLS hostname or path")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				_, _ = w.Write(raw)
			}))
			f := newOAuthFixture(t,
				"writer client", "scope client", "read client", "callback returned", "writer returned",
				"writer client", "scope client", "read client", "callback returned", "writer returned")
			c, err := NewClients(f, core.PublicAdmission{}, nil)
			if err != nil {
				t.Fatal(err)
			}
			c.fetch = fetch
			c.now, fetch.now = func() time.Time { return f.now }, func() time.Time { return f.now }
			f.client.read = func(got string, lock bool) (store.OAuthClient, error) {
				f.equal(got, id)
				f.equal(lock, true)
				return store.OAuthClient{}, model.ErrNotFound
			}
			parseCalls := 0
			c.operations.parseCIMDMetadata = func(data []byte, expectedID string) (core.ClientMetadata, error) {
				parseCalls++
				f.equal(data, raw)
				f.equal(expectedID, id)
				return core.ParseCIMDClientMetadata(data, expectedID)
			}
			var first core.ValidatedClient
			for i := range 2 {
				f.plan("client", true, model.ErrNotFound, store.TransactionNotCommitted, model.ErrNotFound)
				got, err := c.Resolve(f.ctx, id, tc.redirect)
				if err != nil || got.ClientID != id || got.Provenance != "cimd" || got.SelectedExactRedirect != tc.redirect || got.MetadataDeadline != f.now.Add(time.Hour) || len(got.MetadataDigest) != 64 {
					t.Fatalf("real CIMD resolution: %+v %v", got, err)
				}
				if i == 0 { first = got } else { f.equal(got, first) }
			}
			f.equal(parseCalls, 2)
			f.equal(dials.Load(), int32(1))
		})
	}
}

func TestClientsCIMDRefusalsAreNotCached(t *testing.T) {
	const id = "https://example.com/client"
	for _, fields := range []string{
		`"grant_types":["urn:ietf:params:oauth:grant-type:device_code"]`,
		`"grant_types":["refresh_token"]`,
		`"grant_types":["authorization_code",null]`,
		`"response_types":["token"]`,
		`"client_id":"https://other.example/client"`,
	} {
		t.Run(fields, func(t *testing.T) {
			raw := `{"client_id":"`+id+`","redirect_uris":["http://localhost/cb"],`+fields+`}`
			if strings.HasPrefix(fields, `"client_id"`) {
				raw = `{"redirect_uris":["http://localhost/cb"],`+fields+`}`
			}
			fetch, _, dials := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(raw)) }))
			f := newOAuthFixture(t,
				"writer client", "scope client", "read client", "callback returned", "writer returned",
				"writer client", "scope client", "read client", "callback returned", "writer returned")
			c, err := NewClients(f, core.PublicAdmission{}, nil)
			if err != nil { t.Fatal(err) }
			c.fetch = fetch
			f.client.read = func(got string, lock bool) (store.OAuthClient, error) {
				f.equal(got, id)
				f.equal(lock, true)
				return store.OAuthClient{}, model.ErrNotFound
			}
			for range 2 {
				f.plan("client", true, model.ErrNotFound, store.TransactionNotCommitted, model.ErrNotFound)
				got, err := c.Resolve(f.ctx, id, "http://localhost:123/cb")
				if err != core.ErrInvalidClient || !reflect.DeepEqual(got, core.ValidatedClient{}) {
					t.Fatalf("invalid CIMD exposed client: %+v %v", got, err)
				}
			}
			f.equal(dials.Load(), int32(2))
		})
	}
}

func TestClientsStrictSourcesAndLocalhost(t *testing.T) {
	const id = "https://example.com/client"
	const base = `{"client_id":"`+id+`","redirect_uris":["http://localhost/cb"]`
	unknown := []byte(base+`,"grant_types":["authorization_code","unknown"]}`)
	f := newOAuthFixture(t)
	if c, err := NewClients(f, core.PublicAdmission{}, map[string][]byte{id: unknown}); c != nil || err != core.ErrInvalidClientMetadata {
		t.Fatalf("configured capabilities became permissive: %v", err)
	}
	c, err := NewClients(f, core.PublicAdmission{}, map[string][]byte{id: []byte(base+`}`)})
	if err != nil { t.Fatal(err) }
	got, err := c.Resolve(f.ctx, id, "http://localhost:123/cb")
	if err != nil || got.Provenance != "preregistered" || got.SelectedExactRedirect != "http://localhost:123/cb" { t.Fatalf("configured localhost: %+v %v", got, err) }
	t.Run("register", func(t *testing.T) {
		f := newOAuthFixture(t)
		ops := rejectClientOperations(f)
		ops.take = func(context.Context,string,string,string)(bool,error){ return true,nil }
		ops.parseMetadata = core.ParseClientMetadata
		c, err := newClients(f, nil, ops)
		if err != nil { t.Fatal(err) }
		_, err = c.Register(f.ctx, "source", []byte(`{"redirect_uris":["http://localhost/cb"],"grant_types":["authorization_code","unknown"]}`))
		if err != core.ErrInvalidClientMetadata { t.Fatalf("DCR accepted unknown capabilities: %v", err) }
	})
	for _, valid := range []bool{false,true} {
		t.Run(map[bool]string{false:"stored rejection",true:"stored localhost"}[valid],func(t *testing.T){
			steps := []string{"writer client","scope client","read client"}
			if valid { steps = append(steps,"pin client") }
			steps = append(steps,"callback returned","writer returned")
			f := newOAuthFixture(t,steps...)
			c, err := NewClients(f,core.PublicAdmission{},nil)
			if err != nil { t.Fatal(err) }
			raw := unknown
			if valid { raw = []byte(base+`}`) }
			record := store.OAuthClient{ID:id,Metadata:raw,ExpiresAt:f.now.Add(time.Hour)}
			f.client.read = func(got string,lock bool)(store.OAuthClient,error){ f.equal(got,id); f.equal(lock,true); return record,nil }
			f.client.pin = func(got string,now time.Time)(store.OAuthClient,error){ f.equal(got,id); f.equal(now,f.now); return record,nil }
			c.now = func()time.Time{return f.now}
			wantErr := error(core.ErrInvalidClient)
			if valid { wantErr = nil }
			f.plan("client",true,wantErr,store.TransactionCommitted,wantErr)
			got,err := c.Resolve(f.ctx,id,"http://localhost:123/cb")
			if err != wantErr { t.Fatal(err) }
			if valid && (got.Provenance != "dcr" || got.SelectedExactRedirect != "http://localhost:123/cb") { t.Fatalf("stored localhost: %+v",got) }
		})
	}
}
