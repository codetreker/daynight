package oauth

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestAuthorizationRulesDecisionAndRedemption(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	binding := secret.Random(BindingPrefix)
	request := AuthorizationRequest{ID: "request", Binding: binding, ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", State: "state"}
	a := NewAuthorization(request, now)
	if status, _ := AuthorizationStatus(a, a.ExpiresAt); status != "expired" {
		t.Fatalf("expiry boundary: %s", status)
	}
	if _, err := DecideAuthorization(&a, secret.Random(BindingPrefix), "approve", "user", "https://server.example", now); !errors.Is(err, ErrInvalidAuthorization) || a.Status != "pending" {
		t.Fatalf("wrong binding changed decision: %+v %v", a, err)
	}
	if _, err := DecideAuthorization(&a, binding, "approve", "user", "https://server.example", a.ExpiresAt); !errors.Is(err, ErrInvalidAuthorization) || a.Status != "pending" {
		t.Fatalf("expired decision: %+v %v", a, err)
	}
	callback, err := DecideAuthorization(&a, binding, "approve", "user", "https://server.example", now)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(callback)
	if err != nil || u.Query().Get("state") != "state" || u.Query().Get("code") == "" || a.State != "" || a.StatePresent || a.Status != "approved" {
		t.Fatalf("approval: %+v %q %v", a, callback, err)
	}
	valid := CodeBinding{ClientID: request.ClientID, RedirectURI: request.RedirectURI, Resource: request.Resource, Verifier: strings.Repeat("a", 43)}
	wrong := valid
	wrong.Verifier = strings.Repeat("b", 43)
	if _, err := CheckAuthorizationCode(a, wrong, now); !errors.Is(err, ErrInvalidGrant) || a.Status != "approved" {
		t.Fatalf("wrong verifier: %v", err)
	}
	if replay, err := CheckAuthorizationCode(a, valid, now); replay || err != nil {
		t.Fatalf("valid code: %t %v", replay, err)
	}
	if _, err := CheckAuthorizationCode(a, valid, *a.CodeExpiresAt); !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("code expiry: %v", err)
	}
	ConsumeAuthorization(&a, "grant", now.Add(time.Hour))
	if replay, err := CheckAuthorizationCode(a, valid, now); !replay || err != nil {
		t.Fatalf("replay: %t %v", replay, err)
	}
	if replay, err := CheckAuthorizationCode(a, wrong, now); replay || !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("wrong replay: %t %v", replay, err)
	}
}
