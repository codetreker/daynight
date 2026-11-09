package oauth

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

const MetadataLimit = 64 * 1024

var ErrInvalidClient = errors.New("invalid OAuth client")
var ErrRateLimited = errors.New("OAuth public admission rate limit exceeded")
var ErrInvalidClientMetadata = errors.New("invalid OAuth client metadata")

// ClientMetadata is the supported public-client configuration. Names are self asserted.
type ClientMetadata struct {
	ClientID                string   `json:"client_id,omitempty"`
	ClientName              string   `json:"client_name,omitempty"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types,omitempty"`
	ResponseTypes           []string `json:"response_types,omitempty"`
	Scope                   string   `json:"scope,omitempty"`
}

// ValidatedClient captures the metadata and exact redirect accepted for an
// authorization request. Consumers must persist a copy, not re-resolve it.
type ValidatedClient struct {
	ClientID              string    `json:"clientId"`
	Provenance            string    `json:"provenance"`
	ClientName            string    `json:"clientName,omitempty"`
	MetadataDigest        string    `json:"metadataDigest"`
	Redirects             []string  `json:"redirects"`
	SelectedExactRedirect string    `json:"selectedExactRedirect"`
	MetadataDeadline      time.Time `json:"metadataDeadline"`
}

// ParseClientMetadata accepts only the supported grants and public method. An
// omitted method is deliberately replaced with none by this server.
func ParseClientMetadata(data []byte, expectedID string) (ClientMetadata, error) {
	return parseClientMetadata(data, expectedID, MetadataLimit)
}

// ParseStoredClientMetadata reads a previously validated DCR document after
// JSONB has expanded its representation. The wire input still has a 64 KiB limit.
func ParseStoredClientMetadata(data []byte, expectedID string) (ClientMetadata, error) {
	if expectedID == "" {
		return ClientMetadata{}, ErrInvalidClientMetadata
	}
	return parseClientMetadata(data, expectedID, 2*MetadataLimit+1024)
}

func parseClientMetadata(data []byte, expectedID string, limit int) (ClientMetadata, error) {
	var m ClientMetadata
	if len(data) == 0 || len(data) > limit || !jsonunicode.Valid(data) {
		return m, ErrInvalidClientMetadata
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return m, ErrInvalidClientMetadata
	}
	fields := map[string]json.RawMessage{}
	for dec.More() {
		tok, err = dec.Token()
		if err != nil {
			return m, ErrInvalidClientMetadata
		}
		k, ok := tok.(string)
		if !ok {
			return m, ErrInvalidClientMetadata
		}
		if _, exists := fields[k]; exists {
			return m, ErrInvalidClientMetadata
		}
		var raw json.RawMessage
		if dec.Decode(&raw) != nil {
			return m, ErrInvalidClientMetadata
		}
		fields[k] = raw
	}
	if _, err = dec.Token(); err != nil {
		return m, ErrInvalidClientMetadata
	}
	if dec.Decode(new(any)) != io.EOF {
		return m, ErrInvalidClientMetadata
	}
	for _, field := range []struct {
		key string
		dst any
	}{{"client_id", &m.ClientID}, {"client_name", &m.ClientName}, {"redirect_uris", &m.RedirectURIs}, {"token_endpoint_auth_method", &m.TokenEndpointAuthMethod}, {"grant_types", &m.GrantTypes}, {"response_types", &m.ResponseTypes}, {"scope", &m.Scope}} {
		if raw, ok := fields[field.key]; ok {
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, field.dst) != nil {
				return ClientMetadata{}, ErrInvalidClientMetadata
			}
		}
	}
	if expectedID == "" {
		// These values are issued by the server, not client registration metadata.
		// Unrecognized extensions are ignored rather than reflected or stored.
		for _, key := range []string{"client_id", "client_secret", "client_id_issued_at", "client_secret_expires_at", "registration_access_token", "registration_client_uri"} {
			if _, exists := fields[key]; exists {
				return ClientMetadata{}, ErrInvalidClientMetadata
			}
		}
	}
	if expectedID != "" && m.ClientID != expectedID {
		return ClientMetadata{}, ErrInvalidClientMetadata
	}
	if _, exists := fields["token_endpoint_auth_method"]; !exists {
		m.TokenEndpointAuthMethod = "none"
	}
	if m.TokenEndpointAuthMethod != "none" || len(m.RedirectURIs) == 0 || len(m.ClientName) > 1024 || strings.ContainsRune(m.ClientName, 0) {
		return ClientMetadata{}, ErrInvalidClientMetadata
	}
	if raw, exists := fields["grant_types"]; exists && (len(m.GrantTypes) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))) {
		return ClientMetadata{}, ErrInvalidClientMetadata
	}
	for _, g := range m.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			return ClientMetadata{}, ErrInvalidClientMetadata
		}
	}
	if raw, exists := fields["response_types"]; exists && (len(m.ResponseTypes) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))) {
		return ClientMetadata{}, ErrInvalidClientMetadata
	}
	for _, r := range m.ResponseTypes {
		if r != "code" {
			return ClientMetadata{}, ErrInvalidClientMetadata
		}
	}
	if _, exists := fields["scope"]; exists && m.Scope != Scope {
		return ClientMetadata{}, ErrInvalidClientMetadata
	}
	seen := map[string]bool{}
	for _, uri := range m.RedirectURIs {
		if !ValidRedirect(uri) || seen[uri] {
			return ClientMetadata{}, ErrInvalidClientMetadata
		}
		seen[uri] = true
	}
	return m, nil
}

// ValidRedirect permits HTTPS and local HTTP callbacks, without credentials or fragments.
func ValidRedirect(raw string) bool {
	if raw == "" || !utf8.ValidString(raw) || strings.ContainsAny(raw, "#\x00\r\n\t ") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Hostname() == "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return false
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	if u.Scheme == "http" {
		ip, e := netip.ParseAddr(u.Hostname())
		if e != nil {
			return u.Hostname() == "localhost"
		}
		return ip.Unmap().IsLoopback()
	}
	return true
}

// MatchRedirect preserves exact bytes except the port of a literal loopback IP.
func MatchRedirect(registered, requested string) bool {
	if !ValidRedirect(registered) || !ValidRedirect(requested) {
		return false
	}
	if registered == requested {
		return true
	}
	a, _ := url.Parse(registered)
	b, _ := url.Parse(requested)
	if a.Scheme != "http" || b.Scheme != "http" {
		return false
	}
	ip, err := netip.ParseAddr(a.Hostname())
	if err != nil || !ip.Unmap().IsLoopback() || a.Hostname() != b.Hostname() {
		return false
	}
	return redirectSuffix(registered) == redirectSuffix(requested)
}

// FreezeClient selects the full request URI and hashes the validated metadata.
func FreezeClient(id, provenance string, metadata ClientMetadata, deadline time.Time, redirect string) (ValidatedClient, error) {
	if id == "" || (provenance != "preregistered" && provenance != "cimd" && provenance != "dcr") {
		return ValidatedClient{}, ErrInvalidClient
	}
	match := false
	for _, r := range metadata.RedirectURIs {
		if MatchRedirect(r, redirect) {
			match = true
			break
		}
	}
	if !match {
		return ValidatedClient{}, ErrInvalidClient
	}
	canonical, err := json.Marshal(metadata)
	if err != nil {
		return ValidatedClient{}, ErrInvalidClient
	}
	digest := sha256.Sum256(canonical)
	return ValidatedClient{ClientID: id, Provenance: provenance, ClientName: metadata.ClientName, MetadataDigest: hex.EncodeToString(digest[:]), Redirects: append([]string(nil), metadata.RedirectURIs...), SelectedExactRedirect: redirect, MetadataDeadline: deadline}, nil
}

// Compare the raw suffix so only the port, never path or query encoding, can differ.
func redirectSuffix(raw string) string {
	authority := strings.Index(raw, "://") + 3
	if offset := strings.IndexAny(raw[authority:], "/?"); offset >= 0 {
		return raw[authority+offset:]
	}
	return ""
}
