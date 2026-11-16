package oauth

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestClientIDMetadataDocumentGrantCapabilities(t *testing.T) {
	const id = "https://client.example/metadata.json"
	for _, tc := range []struct {
		name, grants string
		valid        bool
	}{
		{"omitted default", "", true},
		{"code", `["authorization_code"]`, true},
		{"shared device grant", `["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"]`, true},
		{"other registered grant", `["client_credentials","authorization_code"]`, true},
		{"absolute extension URI", `["https://client.example/grants/custom","authorization_code"]`, true},
		{"no code grant", `["refresh_token","urn:ietf:params:oauth:grant-type:device_code"]`, false},
		{"empty list", `[]`, false},
		{"null list", `null`, false},
		{"string instead of list", `"authorization_code"`, false},
		{"non-string member", `["authorization_code",7]`, false},
		{"null member", `["authorization_code",null]`, false},
		{"empty member", `["authorization_code",""]`, false},
		{"space", `["authorization_code","device code"]`, false},
		{"control", `["authorization_code","device\u0000code"]`, false},
		{"non-ASCII", `["authorization_code","dévice"]`, false},
		{"relative extension URI", `["authorization_code","/grants/device"]`, false},
		{"malformed URI escape", `["authorization_code","https://client.example/%zz"]`, false},
		{"malformed opaque URI escape", `["authorization_code","urn:example:%zz"]`, false},
		{"invalid opaque URI character", `["authorization_code","urn:example:device|code"]`, false},
		{"URI fragment", `["authorization_code","https://client.example/grant#fragment"]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := `{"client_id":"` + id + `","redirect_uris":["https://client.example/callback"]`
			if tc.grants != "" {
				raw += `,"grant_types":` + tc.grants
			}
			raw += `}`
			got, err := ParseClientIDMetadataDocument([]byte(raw), id)
			if !tc.valid {
				if !errors.Is(err, ErrInvalidClientMetadata) || !reflect.DeepEqual(got, ClientMetadata{}) {
					t.Fatalf("invalid capabilities = %+v, %v", got, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var grants []string
			if tc.grants != "" {
				if err := json.Unmarshal([]byte(tc.grants), &grants); err != nil {
					t.Fatal(err)
				}
			}
			want := ClientMetadata{ClientID: id, RedirectURIs: []string{"https://client.example/callback"}, TokenEndpointAuthMethod: "none", GrantTypes: grants}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("capabilities = %+v; want %+v", got, want)
			}
		})
	}
}

func TestClientIDMetadataDocumentPreservesIdentityAndPublicCodeConstraints(t *testing.T) {
	const id = "https://client.example/metadata.json"
	for _, tc := range []struct {
		name, field, expectedID string
	}{
		{"missing expected identity", `"client_id":"` + id + `"`, ""},
		{"mismatched identity", `"client_id":"https://other.example/metadata.json"`, id},
		{"missing identity", `"client_name":"Client"`, id},
		{"confidential method", `"client_id":"` + id + `","token_endpoint_auth_method":"client_secret_basic"`, id},
		{"unsupported response", `"client_id":"` + id + `","response_types":["code","token"]`, id},
		{"unsupported scope", `"client_id":"` + id + `","scope":"other"`, id},
		{"duplicate grants", `"client_id":"` + id + `","grant_types":["authorization_code"],"grant_types":["authorization_code"]`, id},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := `{"redirect_uris":["https://client.example/callback"],` + tc.field + `}`
			got, err := ParseClientIDMetadataDocument([]byte(raw), tc.expectedID)
			if !errors.Is(err, ErrInvalidClientMetadata) || !reflect.DeepEqual(got, ClientMetadata{}) {
				t.Fatalf("unsafe document = %+v, %v", got, err)
			}
		})
	}
	for _, redirect := range []string{"http://client.example/callback", "https://client.example/callback#fragment", "https://user@client.example/callback", "vscode://callback"} {
		t.Run(redirect, func(t *testing.T) {
			raw, err := json.Marshal(ClientMetadata{ClientID: id, RedirectURIs: []string{redirect}, TokenEndpointAuthMethod: "none", GrantTypes: []string{"authorization_code", "urn:ietf:params:oauth:grant-type:device_code"}})
			if err != nil {
				t.Fatal(err)
			}
			if got, err := ParseClientIDMetadataDocument(raw, id); !errors.Is(err, ErrInvalidClientMetadata) || !reflect.DeepEqual(got, ClientMetadata{}) {
				t.Fatalf("unsafe redirect = %+v, %v", got, err)
			}
		})
	}
}

func TestRegisteredMetadataDoesNotAdoptCIMDGrantPolicy(t *testing.T) {
	const id = "registered"
	const grants = `"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"]`
	const redirects = `"redirect_uris":["http://127.0.0.1/callback"]`
	for _, tc := range []struct {
		name, raw, expectedID string
		parse                 func([]byte, string) (ClientMetadata, error)
	}{
		{"dynamic registration", `{` + redirects + `,` + grants + `}`, "", ParseClientMetadata},
		{"preregistration", `{"client_id":"` + id + `",` + redirects + `,` + grants + `}`, id, ParseClientMetadata},
		{"stored registration", `{"client_id":"` + id + `",` + redirects + `,` + grants + `}`, id, ParseStoredClientMetadata},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := tc.parse([]byte(tc.raw), tc.expectedID); !errors.Is(err, ErrInvalidClientMetadata) || !reflect.DeepEqual(got, ClientMetadata{}) {
				t.Fatalf("registration accepted unimplemented grant: %+v, %v", got, err)
			}
		})
	}
}
