package oauth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestClientMetadata(t *testing.T) {
	valid := `{"client_name":"Self asserted","redirect_uris":["https://client.example/cb"]}`
	m, err := ParseClientMetadata([]byte(valid), "")
	if err != nil || m.TokenEndpointAuthMethod != "none" {
		t.Fatalf("metadata: %+v %v", m, err)
	}
	for _, raw := range []string{
		`{"redirect_uris":["https://client.example/cb"],"token_endpoint_auth_method":"client_secret_basic"}`,
		`{"redirect_uris":["https://client.example/cb"],"token_endpoint_auth_method":null}`,
		`{"redirect_uris":["https://client.example/cb"],"grant_types":["client_credentials"]}`,
		`{"redirect_uris":["https://client.example/cb"],"scope":"other"}`,
		`{"redirect_uris":["https://client.example/cb"],"response_types":["token"]}`,
		`{"redirect_uris":["https://client.example/cb"],"redirect_uris":[]}`,
		`{"redirect_uris":["https://client.example/cb"],"client_id":"supplied"}`,
		`{"redirect_uris":["https://client.example/cb"],"client_name":"\ud800"}`,
		`{"redirect_uris":["https://client.example/cb#fragment"]}`,
		`{"redirect_uris":["https://client.example/cb"],"client_secret":"supplied"}`,
		`{"redirect_uris":["https://client.example/cb"],"client_id_issued_at":0}`,
		`{"redirect_uris":["https://client.example/cb"],"client_secret_expires_at":0}`,
		`{"redirect_uris":["https://client.example/cb"],"registration_access_token":"x"}`,
		`{"redirect_uris":["https://client.example/cb"],"registration_client_uri":"https://client.example/manage"}`,
		`{"redirect_uris":["https://client.example/cb"],"extension":true,"extension":false}`,
		strings.Repeat(" ", MetadataLimit+1),
		`{"redirect_uris":[],"token_endpoint_auth_method":"client_secret_basic"}`,
	} {
		if got, err := ParseClientMetadata([]byte(raw), ""); !errors.Is(err, ErrInvalidClientMetadata) || !reflect.DeepEqual(got, ClientMetadata{}) {
			t.Errorf("accepted %s", raw[:min(len(raw), 100)])
		}
	}
	extension := `{"redirect_uris":["https://client.example/cb"],"logo_uri":"https://client.example/logo","software_id":"sample","extension":{"value":true}}`
	extended, err := ParseClientMetadata([]byte(extension), "")
	if err != nil || extended.TokenEndpointAuthMethod != "none" || len(extended.RedirectURIs) != 1 {
		t.Fatalf("extension metadata: %+v %v", extended, err)
	}
	cimd := `{"client_id":"https://client.example/meta","redirect_uris":["http://127.0.0.1:123/cb"],"logo_uri":"https://ignored.example"}`
	if _, err := ParseClientMetadata([]byte(cimd), "https://wrong.example/meta"); err == nil {
		t.Fatal("accepted mismatched client_id")
	}
	m, err = ParseClientMetadata([]byte(cimd), "https://client.example/meta")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().UTC()
	snapshot, err := FreezeClient(m.ClientID, "cimd", m, deadline, "http://127.0.0.1:456/cb")
	if err != nil {
		t.Fatal(err)
	}
	m.RedirectURIs[0] = "changed"
	if snapshot.Redirects[0] != "http://127.0.0.1:123/cb" || snapshot.SelectedExactRedirect != "http://127.0.0.1:456/cb" {
		t.Fatal(snapshot)
	}
	b, err := json.Marshal(snapshot)
	if err != nil || len(b) == 0 {
		t.Fatal(err)
	}
}

func TestRedirectMatching(t *testing.T) {
	cases := []struct {
		registered, requested string
		match                 bool
	}{
		{"https://client.example/cb?x=1", "https://client.example/cb?x=1", true},
		{"https://client.example/cb", "https://client.example:443/cb", false},
		{"http://127.0.0.1:123/cb?x=1", "http://127.0.0.1:456/cb?x=1", true},
		{"http://[::1]:123/cb", "http://[::1]:456/cb", true},
		{"http://127.0.0.1:123/cb?x=1", "http://127.0.0.1:456/cb?x=2", false},
		{"http://localhost:123/cb", "http://localhost:456/cb", false},
		{"http://localhost:123/cb", "http://localhost:123/cb", true},
		{"http://localhost/cb?x=1", "http://localhost:1/cb?x=1", true},
		{"http://localhost/cb?x=1", "http://localhost:65535/cb?x=1", true},
		{"http://localhost/cb", "http://localhost:80/cb", true},
		{"http://localhost:80/cb", "http://localhost/cb", false},
		{"http://localhost:80/cb", "http://localhost:080/cb", false},
		{"http://localhost/cb", "http://localhost:0/cb", false},
		{"http://localhost/cb", "http://localhost:65536/cb", false},
		{"http://localhost/cb", "http://localhost:/cb", false},
		{"http://localhost/cb", "http://localhost:bad/cb", false},
		{"http://localhost", "http://localhost:123", true},
		{"http://localhost", "http://localhost:123/", false},
		{"http://localhost/cb", "http://localhost:123/%63b", false},
		{"http://localhost/cb?x=1&y=2", "http://localhost:123/cb?y=2&x=1", false},
		{"http://localhost/cb", "http://localhost:123/cb?", false},
		{"http://localhost/cb", "http://127.0.0.1:123/cb", false},
		{"http://localhost/cb", "http://[::1]:123/cb", false},
		{"http://localhost/cb", "http://localhost.:123/cb", false},
		{"http://localhost/cb", "http://sub.localhost:123/cb", false},
		{"http://localhost/cb", "http://localhost.evil:123/cb", false},
		{"http://localhost/cb", "http://LOCALHOST:123/cb", false},
		{"http://localhost/cb", "http://user@localhost:123/cb", false},
		{"http://localhost/cb", "http://localhost:123/cb#fragment", false},
		{"http://localhost/cb", "https://localhost:123/cb", false},
		{"https://localhost/cb", "https://localhost:123/cb", false},
		{"http://evil.example/cb", "http://evil.example/cb", false},
		{"https://user@client.example/cb", "https://user@client.example/cb", false},
		{"https://client.example/cb#", "https://client.example/cb#", false},
		{"http://127.0.0.1:123/cb", "http://127.0.0.2:456/cb", false},
		{"http://127.0.0.1:123/%63b", "http://127.0.0.1:456/cb", false},
		{"http://127.0.0.1:123/é", "http://127.0.0.1:456/%C3%A9", false},
	}
	for _, c := range cases {
		if got := MatchRedirect(c.registered, c.requested); got != c.match {
			t.Errorf("%q %q = %v", c.registered, c.requested, got)
		}
	}
}

// Public documents captured on 2026-11-16; extensions and capabilities are intact.
func TestCIMDPublicClientDocuments(t *testing.T) {
	for _, tc := range []struct {
		file, id  string
		redirects []string
	}{
		{"claude.json", "https://claude.ai/oauth/claude-code-client-metadata", []string{"http://localhost:49416/callback", "http://localhost:65535/callback", "http://127.0.0.1:123/callback"}},
		{"copilot.json", "https://github.com/copilot/cli/client-metadata.json", []string{"http://127.0.0.1:123/", "http://127.0.0.1:456/callback"}},
	} {
		t.Run(tc.file, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "oauth", tc.file))
			if err != nil {
				t.Fatal(err)
			}
			m, err := ParseCIMDClientMetadata(raw, tc.id)
			if err != nil || !reflect.DeepEqual(m.GrantTypes, []string{"authorization_code", "refresh_token"}) || !reflect.DeepEqual(m.ResponseTypes, []string{"code"}) {
				t.Fatalf("public document: %+v %v", m, err)
			}
			for _, redirect := range tc.redirects {
				snapshot, err := FreezeClient(tc.id, "cimd", m, time.Time{}, redirect)
				if err != nil || snapshot.SelectedExactRedirect != redirect || !reflect.DeepEqual(snapshot.Redirects, m.RedirectURIs) || len(snapshot.MetadataDigest) != 64 {
					t.Fatalf("freeze: %+v %v", snapshot, err)
				}
			}
			if _, err := FreezeClient(tc.id, "cimd", m, time.Time{}, "http://127.0.0.1:123/other"); err != ErrInvalidClient {
				t.Fatalf("unregistered path: %v", err)
			}
		})
	}
}

func TestCIMDCapabilityIntersection(t *testing.T) {
	const base = `{"client_id":"https://client.example/meta","redirect_uris":["http://localhost/cb"]`
	for _, tc := range []struct {
		name, fields string
		grants       []string
	}{
		{"both omitted", "", []string{"authorization_code"}},
		{"grants omitted", `,"response_types":["unknown","code","code"]`, []string{"authorization_code"}},
		{"responses omitted", `,"grant_types":["refresh_token","other","authorization_code","authorization_code"]`, []string{"authorization_code", "refresh_token"}},
		{"code only", `,"grant_types":["authorization_code"],"response_types":["code"]`, []string{"authorization_code"}},
		{"unknown superset", `,"grant_types":["other","refresh_token","authorization_code","future"],"response_types":["token","code","future"]`, []string{"authorization_code", "refresh_token"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, err := ParseCIMDClientMetadata([]byte(base+tc.fields+`}`), "https://client.example/meta")
			if err != nil || !reflect.DeepEqual(m.GrantTypes, tc.grants) || !reflect.DeepEqual(m.ResponseTypes, []string{"code"}) || m.TokenEndpointAuthMethod != "none" {
				t.Fatalf("intersection: %+v %v", m, err)
			}
		})
	}
	for _, field := range []string{"grant_types", "response_types"} {
		for _, invalid := range []string{`[]`, `null`, `"code"`, `{}`, `true`, `[""]`, `[null]`, `["authorization_code","code",null]`, `[null,"authorization_code","code"]`, `["authorization_code","code",1]`, `["authorization_code","code",{}]`, `["authorization_code","code",""]`} {
			raw := base + `,"` + field + `":` + invalid + `}`
			if got, err := ParseCIMDClientMetadata([]byte(raw), "https://client.example/meta"); err != ErrInvalidClientMetadata || !reflect.DeepEqual(got, ClientMetadata{}) {
				t.Errorf("accepted malformed %s=%s: %+v %v", field, invalid, got, err)
			}
		}
	}
	for _, fields := range []string{
		`,"grant_types":["urn:ietf:params:oauth:grant-type:device_code"]`,
		`,"grant_types":["refresh_token"]`,
		`,"grant_types":["unknown"]`,
		`,"response_types":["token"]`,
		`,"grant_types":["authorization_code"],"response_types":["unknown"]`,
		`,"grant_types":["authorization_code"],"grant_types":["authorization_code"]`,
		`,"response_types":["code"],"response_types":["code"]`,
		`,"grant_types":["authorization_code","\ud800"]`,
		`,"token_endpoint_auth_method":"client_secret_basic"`,
		`,"scope":"other"`,
		`,"redirect_uris":["http://localhost/cb"]`,
	} {
		if _, err := ParseCIMDClientMetadata([]byte(base+fields+`}`), "https://client.example/meta"); err != ErrInvalidClientMetadata {
			t.Errorf("accepted invalid CIMD %s: %v", fields, err)
		}
	}
	for _, tc := range []struct{ raw, id string }{
		{base + `}`, ""},
		{base + `}`, "other"},
		{base, "https://client.example/meta"},
		{base + `} {}`, "https://client.example/meta"},
		{strings.Repeat(" ", MetadataLimit+1), "https://client.example/meta"},
		{`{"client_id":"https://client.example/meta","redirect_uris":["http://localhost/cb","http://localhost/cb"]}`, "https://client.example/meta"},
	} {
		if _, err := ParseCIMDClientMetadata([]byte(tc.raw), tc.id); err != ErrInvalidClientMetadata {
			t.Errorf("accepted invalid document: %v", err)
		}
	}
}

func TestCIMDPolicyDoesNotChangeStrictClientSources(t *testing.T) {
	for _, capabilities := range []string{
		`,"grant_types":["authorization_code","refresh_token","unknown"]`,
		`,"response_types":["code","unknown"]`,
	} {
		base := `{"redirect_uris":["http://localhost/cb"]`
		registered := []byte(base + `,"client_id":"https://client.example/meta"` + capabilities + `}`)
		if _, err := ParseCIMDClientMetadata(registered, "https://client.example/meta"); err != nil {
			t.Fatal(err)
		}
		for _, parse := range []func([]byte, string) (ClientMetadata, error){ParseClientMetadata, ParseStoredClientMetadata} {
			if _, err := parse(registered, "https://client.example/meta"); err != ErrInvalidClientMetadata {
				t.Fatalf("strict source accepted unknown capability: %v", err)
			}
		}
		if _, err := ParseClientMetadata([]byte(base+capabilities+`}`), ""); err != ErrInvalidClientMetadata {
			t.Fatalf("DCR accepted unknown capability: %v", err)
		}
	}
}
func TestStoredMetadataRequiresIdentity(t *testing.T) {
	if _, err := ParseStoredClientMetadata([]byte(`{"redirect_uris":["https://client.example"]}`), ""); err != ErrInvalidClientMetadata {
		t.Fatalf("missing identity: %v", err)
	}
}

func TestStoredMetadataRetainsValidatedIdentity(t *testing.T) {
	raw := []byte(`{"client_id":"registered","client_name":"Desktop","redirect_uris":["https://client.example/cb"]}`)
	metadata, err := ParseStoredClientMetadata(raw, "registered")
	if err != nil || metadata.ClientID != "registered" || metadata.ClientName != "Desktop" || metadata.TokenEndpointAuthMethod != "none" || len(metadata.RedirectURIs) != 1 || metadata.RedirectURIs[0] != "https://client.example/cb" {
		t.Fatalf("stored metadata = %+v, %v", metadata, err)
	}
	if _, err := ParseStoredClientMetadata(raw, "other"); err != ErrInvalidClientMetadata {
		t.Fatalf("mismatched stored identity = %v", err)
	}
}

func TestFreezeClientRejectsInvalidIdentityAndRedirect(t *testing.T) {
	metadata := ClientMetadata{ClientID: "registered", RedirectURIs: []string{"https://client.example/cb"}}
	for _, tc := range []struct{ id, provenance, redirect string }{
		{"", "dcr", "https://client.example/cb"},
		{"registered", "unknown", "https://client.example/cb"},
		{"registered", "dcr", "https://other.example/cb"},
	} {
		if _, err := FreezeClient(tc.id, tc.provenance, metadata, time.Now(), tc.redirect); err != ErrInvalidClient {
			t.Fatalf("FreezeClient(%+v) = %v", tc, err)
		}
	}
}

func TestLoopbackRedirectWithoutPath(t *testing.T) {
	if !MatchRedirect("http://127.0.0.1:123", "http://127.0.0.1:456") {
		t.Fatal("literal loopback port should be permitted with empty path")
	}
	if MatchRedirect("http://127.0.0.1:123", "http://127.0.0.1:456/") {
		t.Fatal("empty and slash paths differ")
	}
}
