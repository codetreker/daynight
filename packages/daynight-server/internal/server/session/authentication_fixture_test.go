package session_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type routeCredential struct {
	token     string
	principal model.Principal
	err       error
}

type routeAuthentication struct {
	Authentication *authhttp.RequestAuthentication
	OnFailure      func(error)
	t              *testing.T
	mu             sync.Mutex
	credentials    []routeCredential
	calls          int
	expected       *int
}

func newRouteAuthentication(t *testing.T, origin string) *routeAuthentication {
	t.Helper()
	fixture := &routeAuthentication{t: t}
	authentication, err := authhttp.NewRequestAuthentication(fixture.authenticate, configpkg.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: strings.HasPrefix(origin, "http://")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	fixture.Authentication = authentication
	t.Cleanup(func() {
		fixture.mu.Lock()
		calls, expected := fixture.calls, fixture.expected
		fixture.mu.Unlock()
		if expected != nil && calls != *expected {
			t.Errorf("authentication calls = %d, want %d", calls, *expected)
		}
	})
	return fixture
}

func (f *routeAuthentication) Credential(principal model.Principal) string {
	f.t.Helper()
	if principal.UserID == "" || principal.CredentialID == "" {
		f.t.Fatal("authentication reply needs supplied user and credential IDs")
	}
	var prefix string
	switch principal.Kind {
	case model.PATCredential:
		prefix = "dnpat_"
	case model.SessionCredential:
		prefix = "dnst_"
	default:
		f.t.Fatalf("unsupported authentication fixture credential kind %q", principal.Kind)
	}
	token := secret.Random(prefix)
	f.mu.Lock()
	f.credentials = append(f.credentials, routeCredential{token: token, principal: principal})
	f.mu.Unlock()
	return token
}

func (f *routeAuthentication) RejectCredential(token string, cause error) {
	f.t.Helper()
	if cause == nil {
		f.t.Fatal("rejected authentication reply needs an error")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for index, credential := range f.credentials {
		if credential.token == token {
			f.credentials[index].err = cause
			return
		}
	}
	f.t.Fatal("authentication rejection targeted an unconfigured credential")
}

func (f *routeAuthentication) ExpectCalls(count int) {
	f.t.Helper()
	if count < 0 {
		f.t.Fatal("authentication expected count must be nonnegative")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.expected != nil && f.calls != *f.expected {
		f.t.Error("authentication phase replaced before its expected calls completed")
	}
	expected := f.calls + count
	f.expected = &expected
}

func (f *routeAuthentication) Count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *routeAuthentication) failure(method string) error {
	cause := fmt.Errorf("unexpected authentication fixture call %s", method)
	f.t.Error(cause)
	if f.OnFailure != nil {
		f.OnFailure(cause)
	}
	return cause
}

func (f *routeAuthentication) authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	f.mu.Lock()
	f.calls++
	extra := f.expected != nil && f.calls > *f.expected
	var principal model.Principal
	var cause error
	configured := false
	for _, credential := range f.credentials {
		if credential.token == token && credential.principal.Kind == kind {
			principal, cause, configured = credential.principal, credential.err, true
			break
		}
	}
	f.mu.Unlock()
	if extra {
		return model.Principal{}, f.failure("Authenticate count")
	}
	if !configured {
		return model.Principal{}, f.failure("Authenticate credentials")
	}
	if err := ctx.Err(); err != nil {
		return model.Principal{}, err
	}
	return principal, cause
}
