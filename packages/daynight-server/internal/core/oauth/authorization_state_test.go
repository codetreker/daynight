package oauth

import (
	"bytes"
	"encoding/json"
	"errors"
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
	want := store.OAuthAuthorization{ID: request.ID, BindingHash: secret.Hash(binding), Client: bytes.Clone(client), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", State: "s", StatePresent: true, Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(10*time.Minute + 24*time.Hour)}
	got := NewAuthorization(request, now)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("authorization = %+v, want %+v", got, want)
	}
	code, codeExpiry := secret.Random(CodePrefix), now.Add(5*time.Minute)
	got = store.OAuthAuthorization{ID: request.ID, BindingHash: secret.Hash(binding), Client: bytes.Clone(client), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", State: "", StatePresent: false, Status: "approved", UserID: uuid.NewString(), CodeHash: secret.Hash(code), CodeExpiresAt: &codeExpiry, CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(24 * time.Hour)}
	want = copyAuthorizationForComparison(got)
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
