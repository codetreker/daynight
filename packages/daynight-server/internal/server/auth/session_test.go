package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestAuthenticateSessionRequestRequiresSingleBrowserCookie(t *testing.T) {
	calls := 0
	failure := errors.New("identity unavailable")
	h := &RequestAuthentication{secure: true, logger: slog.Default(), authenticate: func(_ context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		calls++
		if kind != model.SessionCredential || value != "session-value" {
			t.Fatalf("credential %s %q", kind, value)
		}
		return model.Principal{Kind: kind, CredentialID: "session"}, failure
	}}
	for _, cookie := range []string{"", "__Host-daynight_session=one; __Host-daynight_session=two"} {
		r := httptest.NewRequest("GET", "https://daynight.test/", nil)
		r.Header.Set("Cookie", cookie)
		if _, err := h.AuthenticateSessionRequest(r); err == nil {
			t.Fatal("invalid cookie admitted")
		}
	}
	r := httptest.NewRequest("GET", "https://daynight.test/", nil)
	r.Header.Set("Cookie", "__Host-daynight_session=session-value")
	r.Header.Set("Authorization", "Bearer pat-value")
	if _, err := h.AuthenticateSessionRequest(r); err == nil || calls != 0 {
		t.Fatal("bearer request entered session operation")
	}
	r.Header.Del("Authorization")
	p, err := h.AuthenticateSessionRequest(r)
	if !errors.Is(err, failure) || p.CredentialID != "session" || calls != 1 {
		t.Fatalf("identity result lost: %+v %v %d", p, err, calls)
	}
}
