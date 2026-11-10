package oauth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestAuthorizationCreationAndConsumptionPreserveCompleteRecord(t *testing.T) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	binding := secret.Random(BindingPrefix)
	client := json.RawMessage(`{"clientId":"client","provenance":"preregistered","metadataDigest":"digest","redirects":["https://client.example/cb"],"selectedExactRedirect":"https://client.example/cb","metadataDeadline":"0001-01-01T00:00:00Z"}`)
	request := AuthorizationRequest{ID: uuid.NewString(), Binding: binding, ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", State: "s", StatePresent: true, Client: client}
	for _, state := range []struct {
		name    string
		value   string
		present bool
	}{{"state present", "s", true}, {"state absent", "", false}} {
		t.Run(state.name, func(t *testing.T) {
			input := request
			input.Client = bytes.Clone(client)
			input.State, input.StatePresent = state.value, state.present
			want := store.OAuthAuthorization{ID: request.ID, BindingHash: secret.Hash(binding), Client: bytes.Clone(client), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", State: state.value, StatePresent: state.present, Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(10*time.Minute + 24*time.Hour)}
			if !state.present {
				const acceptanceClient = `{"clientId":"acceptance-client","provenance":"preregistered","clientName":"Acceptance","metadataDigest":"d7a34b959eeaa8cc6fec30336193084ae8ca65f7a0334f615a269da704688220","redirects":["https://client.example/callback"],"selectedExactRedirect":"https://client.example/callback","metadataDeadline":"0001-01-01T00:00:00Z"}`
				digest := sha256.Sum256([]byte(strings.Repeat("v", 43)))
				challenge := base64.RawURLEncoding.EncodeToString(digest[:])
				input = AuthorizationRequest{ID: request.ID, Binding: binding, Client: json.RawMessage(acceptanceClient), ClientID: "acceptance-client", RedirectURI: "https://client.example/callback", Resource: "http://127.0.0.1:8787/mcp", Scope: Scope, Challenge: challenge, State: "", StatePresent: false}
				want = store.OAuthAuthorization{ID: request.ID, BindingHash: secret.Hash(binding), Client: json.RawMessage(acceptanceClient), ClientID: "acceptance-client", RedirectURI: "https://client.example/callback", Resource: "http://127.0.0.1:8787/mcp", Scope: Scope, Challenge: challenge, State: "", StatePresent: false, Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(10*time.Minute + 24*time.Hour)}
			}
			got := NewAuthorization(input, now)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("authorization = %+v, want %+v", got, want)
			}
		})
	}
	code, codeExpiry := secret.Random(CodePrefix), now.Add(5*time.Minute)
	got := store.OAuthAuthorization{ID: request.ID, BindingHash: secret.Hash(binding), Client: bytes.Clone(client), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", State: "", StatePresent: false, Status: "approved", UserID: uuid.NewString(), CodeHash: secret.Hash(code), CodeExpiresAt: &codeExpiry, CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(24 * time.Hour)}
	want := copyAuthorizationForComparison(got)
	grantID, retained := uuid.NewString(), now.Add(30*24*time.Hour)
	ConsumeAuthorization(&got, grantID, retained)
	want.Status, want.GrantID, want.RetainUntil = "consumed", grantID, retained
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("consumed authorization = %+v, want %+v", got, want)
	}
	if status, codeExpired := AuthorizationStatus(got, now); status != "consumed" || codeExpired {
		t.Fatalf("consumed projection = %q/%v, want consumed/false", status, codeExpired)
	}
}

func TestAuthorizationStatusPreservesApprovedFactAfterCodeExpiry(t *testing.T) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	expired := now.Add(-time.Second)
	a := store.OAuthAuthorization{ID: uuid.NewString(), Status: "approved", UserID: uuid.NewString(), ClientID: "client", CodeHash: secret.Hash(secret.Random(CodePrefix)), CodeExpiresAt: &expired, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(24 * time.Hour)}
	before := copyAuthorizationForComparison(a)
	status, codeExpired := AuthorizationStatus(a, now)
	if status != "approved" || !codeExpired || !reflect.DeepEqual(a, before) {
		t.Fatalf("approved expiry = %q/%v, record %+v; want unchanged approved fact", status, codeExpired, a)
	}
}

func TestAuthorizationCodeAdmissionSeparatesBindingFromExpiry(t *testing.T) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	expired := now.Add(-time.Second)
	a := store.OAuthAuthorization{ID: uuid.NewString(), Status: "approved", ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", CodeExpiresAt: &expired}
	before := copyAuthorizationForComparison(a)
	binding := CodeBinding{ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Verifier: strings.Repeat("a", 43)}
	if err := CheckAuthorizationCodeBinding(a, binding); err != nil {
		t.Fatalf("correct binding rejected by expired code: %v", err)
	}
	if err := CheckAuthorizationCodeExpiry(a, now); !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("expired code = %v, want invalid grant", err)
	}
	if replay, err := CheckAuthorizationCode(a, binding, now); replay || !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("expired redemption = %v, %v", replay, err)
	}
	binding.Verifier = strings.Repeat("b", 43)
	if err := CheckAuthorizationCodeBinding(a, binding); !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("wrong verifier accepted expired code: %v", err)
	}
	if !reflect.DeepEqual(a, before) {
		t.Fatal("binding or expiry checks changed the authorization")
	}
}

func copyAuthorizationForComparison(a store.OAuthAuthorization) store.OAuthAuthorization {
	a.BindingHash = bytes.Clone(a.BindingHash)
	a.Client = bytes.Clone(a.Client)
	a.CodeHash = bytes.Clone(a.CodeHash)
	if a.CodeExpiresAt != nil {
		expiry := *a.CodeExpiresAt
		a.CodeExpiresAt = &expiry
	}
	return a
}

func TestAuthorizationDenialPreservesCallbackAndCompleteState(t *testing.T) {
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	a, binding := acceptanceAuthorization(now, "denied-state")
	want := copyAuthorizationForComparison(a)
	want.Status = "denied"
	want.UserID = "a1111111-1111-4111-8111-111111111111"
	want.State, want.StatePresent = "", false
	want.RetainUntil = now.Add(24 * time.Hour)

	callback, err := DecideAuthorization(&a, binding, "deny", "a1111111-1111-4111-8111-111111111111", "http://127.0.0.1:8787", now)
	if err != nil || !reflect.DeepEqual(a, want) {
		t.Fatalf("denied authorization = %+v, %v; want %+v", a, err, want)
	}
	u, err := url.Parse(callback)
	if err != nil {
		t.Fatal(err)
	}
	fields := url.Values{"error": {"access_denied"}, "state": {"denied-state"}, "iss": {"http://127.0.0.1:8787"}}
	if u.Scheme != "https" || u.Host != "client.example" || u.Path != "/callback" || !reflect.DeepEqual(u.Query(), fields) || u.Query().Has("code") {
		t.Fatalf("denial callback = %q; want exact error, state and issuer without a code", callback)
	}
}

func TestAuthorizationCodeRejectsHTTPBindingMismatches(t *testing.T) {
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	a, _ := acceptanceAuthorization(now, "original-state")
	code := secret.Random(CodePrefix)
	expiry := now.Add(5 * time.Minute)
	a.Status, a.UserID = "approved", "a1111111-1111-4111-8111-111111111111"
	a.State, a.StatePresent = "", false
	a.CodeHash, a.CodeExpiresAt = secret.Hash(code), &expiry
	a.RetainUntil = now.Add(24 * time.Hour)
	for _, tc := range []struct {
		name       string
		binding    CodeBinding
		validInput bool
	}{
		{"client", CodeBinding{ClientID: "wrong", RedirectURI: "https://client.example/callback", Resource: "http://127.0.0.1:8787/mcp", Verifier: strings.Repeat("v", 43)}, true},
		{"redirect", CodeBinding{ClientID: "acceptance-client", RedirectURI: "https://client.example/other", Resource: "http://127.0.0.1:8787/mcp", Verifier: strings.Repeat("v", 43)}, true},
		{"resource", CodeBinding{ClientID: "acceptance-client", RedirectURI: "https://client.example/callback", Resource: "http://127.0.0.1:8787/other", Verifier: strings.Repeat("v", 43)}, false},
		{"verifier", CodeBinding{ClientID: "acceptance-client", RedirectURI: "https://client.example/callback", Resource: "http://127.0.0.1:8787/mcp", Verifier: strings.Repeat("w", 43)}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			record := copyAuthorizationForComparison(a)
			before := copyAuthorizationForComparison(record)
			if got := ValidAuthorizationCodeInput(code, tc.binding.ClientID, tc.binding.Resource, "http://127.0.0.1:8787/mcp", tc.binding.Verifier); got != tc.validInput {
				t.Fatalf("code input admission = %v, want %v", got, tc.validInput)
			}
			if err := CheckAuthorizationCodeBinding(record, tc.binding); !errors.Is(err, ErrInvalidGrant) {
				t.Fatalf("binding mismatch = %v, want invalid grant", err)
			}
			if !reflect.DeepEqual(record, before) {
				t.Fatal("binding check changed the complete authorization")
			}
			if replay, err := CheckAuthorizationCode(record, tc.binding, now); replay || !errors.Is(err, ErrInvalidGrant) {
				t.Fatalf("mismatched redemption = %v, %v; want false, invalid grant", replay, err)
			}
			if !reflect.DeepEqual(record, before) {
				t.Fatal("redemption check changed the complete authorization")
			}
		})
	}
}

func acceptanceAuthorization(now time.Time, state string) (store.OAuthAuthorization, string) {
	binding := secret.Random(BindingPrefix)
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	client := json.RawMessage(`{"clientId":"acceptance-client","provenance":"preregistered","clientName":"Acceptance","metadataDigest":"d7a34b959eeaa8cc6fec30336193084ae8ca65f7a0334f615a269da704688220","redirects":["https://client.example/callback"],"selectedExactRedirect":"https://client.example/callback","metadataDeadline":"0001-01-01T00:00:00Z"}`)
	return store.OAuthAuthorization{ID: "e5555555-5555-4555-8555-555555555555", BindingHash: secret.Hash(binding), Client: client, ClientID: "acceptance-client", RedirectURI: "https://client.example/callback", Resource: "http://127.0.0.1:8787/mcp", Scope: Scope, Challenge: base64.RawURLEncoding.EncodeToString(challenge[:]), State: state, StatePresent: true, Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(10*time.Minute + 24*time.Hour)}, binding
}
