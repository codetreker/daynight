package auth

import (
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func TestIdentityAuthenticationConfiguration(t *testing.T) {
	client, err := uniauth.New(uniauth.Config{BaseURL: "https://uniauth.example.com", AppID: "test", AppSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	for _, test := range []struct {
		origin       string
		allow, valid bool
	}{
		{"https://daynight.example.com", false, true}, {"https://daynight.example.com", true, true}, {"http://localhost:8787", true, true}, {"http://127.0.0.1:8787", true, true}, {"http://[::1]:8787", true, true}, {"http://127.0.0.1:8787", false, false}, {"http://dev.localhost:8787", true, true}, {"http://localhost.example.com", true, true}, {"http://192.168.1.1", true, true}, {"https://example.com/", false, false}, {"https://example.com?x=1", false, false}, {"https://user@example.com", false, false}, {"https://example.com#secret", false, false}, {"invalid", false, false}, {"https://%zz", false, false}, {"https://example.com:443", false, false}, {"https://EXAMPLE.com", false, false}, {"https://:443", false, false}, {"https://example.com:65536", false, false}, {"https://example.com:", false, false}, {"https://example.com:0443", false, false}, {"http://127.0.0.1:80", true, false},
	} {
		identity := identityservice.New(nil, client, test.origin+"/api/v1/auth/callback")
		auth, err := NewAuthentication(identity, config.AuthSettings{PublicOrigin: test.origin, AllowHTTPTestOrigin: test.allow}, logger)
		if (err == nil) != test.valid {
			t.Fatalf("origin %s allow=%t: %v", test.origin, test.allow, err)
		}
		if err == nil && auth.Origin() != test.origin {
			t.Fatalf("origin = %q, want %q", auth.Origin(), test.origin)
		}
		if err == nil && strings.HasPrefix(test.origin, "https:") {
			cookie := auth.cookie(auth.SessionCookieName(), "secret", time.Now(), 60)
			if cookie.Name != "__Host-daynight_session" || !cookie.Secure || cookie.Domain != "" || !strings.HasPrefix(auth.bindingCookieName("state"), "__Host-daynight_login_") {
				t.Fatal("HTTPS cookie contract")
			}
		}
	}
	_, err = NewAuthentication(identityservice.New(nil, client, "https://wrong.example/api/v1/auth/callback"), config.AuthSettings{PublicOrigin: "https://example.com"}, logger)
	if err == nil {
		t.Fatal("mismatched callback accepted")
	}
	for _, failure := range []struct {
		err  error
		kind string
	}{
		{&uniauth.RequestError{Cause: errors.New("secret")}, "network"},
		{&uniauth.ProtocolError{Reason: "identity_schema"}, "protocol"},
		{&uniauth.APIError{StatusCode: 410}, "protocol"},
	} {
		if got := httpx.ErrorKind(failure.err); got != failure.kind {
			t.Fatalf("kind %s want %s", got, failure.kind)
		}
	}
}
