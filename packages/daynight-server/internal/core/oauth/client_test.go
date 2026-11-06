package oauth

import (
	"encoding/json"
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
		`{"redirect_uris":["https://client.example/cb"],"redirect_uris":[]}`,
		`{"redirect_uris":["https://client.example/cb"],"client_id":"own"}`,
		`{"redirect_uris":["https://client.example/cb"],"client_name":"\ud800"}`,
		`{"redirect_uris":["https://client.example/cb#fragment"]}`,
		`{"redirect_uris":["https://client.example/cb"],"x":true}`,
		strings.Repeat(" ", MetadataLimit+1),
	} {
		if _, err := ParseClientMetadata([]byte(raw), ""); err == nil {
			t.Errorf("accepted %s", raw[:min(len(raw), 100)])
		}
	}
	cimd := `{"client_id":"https://client.example/meta","redirect_uris":["http://127.0.0.1:123/cb"],"logo_uri":"https://ignored.example"}`
	if _, err := ParseClientMetadata([]byte(cimd), "https://other.example/meta"); err == nil {
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
