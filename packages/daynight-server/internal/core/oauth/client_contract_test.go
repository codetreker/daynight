package oauth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestClientRegistrationProjectionRetainsOnlySupportedMetadata(t *testing.T) {
	raw := []byte(`{"client_name":"client","redirect_uris":["http://127.0.0.1:123/cb"],"logo_uri":"https://client.example/logo","software_id":"sample","extension":{"value":true}}`)
	want := ClientMetadata{ClientName: "client", RedirectURIs: []string{"http://127.0.0.1:123/cb"}, TokenEndpointAuthMethod: "none"}
	got, err := ParseClientMetadata(raw, "")
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("registration projection = %+v, %v; want %+v", got, err, want)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"logo_uri", "software_id", "extension", "client_secret"} {
		if _, exists := fields[key]; exists {
			t.Fatalf("public metadata retained %s: %s", key, encoded)
		}
	}
	preregistered := []byte(`{"client_id":"known","redirect_uris":["https://client.example/cb"]}`)
	if got, err := ParseClientMetadata(preregistered, "wrong"); !errors.Is(err, ErrInvalidClientMetadata) || !reflect.DeepEqual(got, ClientMetadata{}) {
		t.Fatalf("mismatched configured identity = %+v, %v", got, err)
	}
}

func TestFreezeClientPreservesCompleteValidatedMetadata(t *testing.T) {
	deadline := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, id, expectedID, raw, redirect string
		metadata                            ClientMetadata
		deadline                            time.Time
	}{
		{
			name: "dcr", id: "registered-client",
			raw:      `{"client_name":"client","redirect_uris":["http://127.0.0.1:123/cb"],"logo_uri":"https://client.example/logo","software_id":"sample","extension":{"value":true}}`,
			redirect: "http://127.0.0.1:456/cb",
			metadata: ClientMetadata{ClientName: "client", RedirectURIs: []string{"http://127.0.0.1:123/cb"}, TokenEndpointAuthMethod: "none"}, deadline: deadline,
		},
		{
			name: "preregistered", id: "known", expectedID: "known",
			raw:      `{"client_id":"known","redirect_uris":["https://client.example/cb"]}`,
			redirect: "https://client.example/cb",
			metadata: ClientMetadata{ClientID: "known", RedirectURIs: []string{"https://client.example/cb"}, TokenEndpointAuthMethod: "none"},
		},
		{
			name: "cimd", id: "https://client.example/meta", expectedID: "https://client.example/meta",
			raw:      `{"client_id":"https://client.example/meta","redirect_uris":["https://client.example/cb"]}`,
			redirect: "https://client.example/cb",
			metadata: ClientMetadata{ClientID: "https://client.example/meta", RedirectURIs: []string{"https://client.example/cb"}, TokenEndpointAuthMethod: "none"}, deadline: deadline,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			metadata, err := ParseClientMetadata([]byte(tc.raw), tc.expectedID)
			if err != nil || !reflect.DeepEqual(metadata, tc.metadata) {
				t.Fatalf("metadata = %+v, %v; want %+v", metadata, err, tc.metadata)
			}
			metadata.ClientID = tc.id
			wantMetadata := tc.metadata
			wantMetadata.ClientID = tc.id
			encoded, err := json.Marshal(wantMetadata)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(encoded)
			want := ValidatedClient{ClientID: tc.id, Provenance: tc.name, ClientName: tc.metadata.ClientName, MetadataDigest: hex.EncodeToString(digest[:]), Redirects: tc.metadata.RedirectURIs, SelectedExactRedirect: tc.redirect, MetadataDeadline: tc.deadline}
			got, err := FreezeClient(tc.id, tc.name, metadata, tc.deadline, tc.redirect)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("frozen client = %+v, %v; want %+v", got, err, want)
			}
			if tc.name == "dcr" {
				got, err := FreezeClient(tc.id, tc.name, metadata, tc.deadline, "https://attacker.example/cb")
				if !errors.Is(err, ErrInvalidClient) || !reflect.DeepEqual(got, ValidatedClient{}) {
					t.Fatalf("attacker redirect = %+v, %v", got, err)
				}
			}
		})
	}
}

func TestLargeRegisteredMetadataCanBeParsedAndFrozenAfterEncoding(t *testing.T) {
	redirect := "https://client.example/" + strings.Repeat("a", MetadataLimit-100)
	raw := []byte(`{"redirect_uris":["` + redirect + `"]}`)
	if len(redirect) != 65459 || len(raw) != 65481 || len(raw) > MetadataLimit {
		t.Fatalf("registration fixture changed: redirect=%d input=%d", len(redirect), len(raw))
	}
	metadata, err := ParseClientMetadata(raw, "")
	if err != nil {
		t.Fatal(err)
	}
	id := secret.Random("dnoac_")
	metadata.ClientID = id
	wantMetadata := ClientMetadata{ClientID: id, RedirectURIs: []string{redirect}, TokenEndpointAuthMethod: "none"}
	if !reflect.DeepEqual(metadata, wantMetadata) {
		t.Fatal("registration changed the complete metadata")
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) != 65581 || len(encoded) <= MetadataLimit {
		t.Fatalf("stored metadata did not cross the wire limit: %d", len(encoded))
	}
	stored, err := ParseStoredClientMetadata(encoded, id)
	if err != nil || !reflect.DeepEqual(stored, wantMetadata) {
		t.Fatalf("stored metadata = %+v, %v; want complete registered metadata", stored, err)
	}
	deadline := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	digest := sha256.Sum256(encoded)
	want := ValidatedClient{ClientID: id, Provenance: "dcr", MetadataDigest: hex.EncodeToString(digest[:]), Redirects: []string{redirect}, SelectedExactRedirect: redirect, MetadataDeadline: deadline}
	got, err := FreezeClient(id, "dcr", stored, deadline, redirect)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("large frozen client = %+v, %v; want complete registered metadata", got, err)
	}
}
