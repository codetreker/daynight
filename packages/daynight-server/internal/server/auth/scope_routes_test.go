package auth

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestAccountRegistrationReportsScopeClasses(t *testing.T) {
	a := &Authentication{RequestAuthentication: &RequestAuthentication{logger: slog.Default()}, callbackPath: "/auth/callback"}
	mux := http.NewServeMux()
	got := map[string]ScopeRoute{}
	a.RegisterRoutesWithScopeObserver(mux, func(route ScopeRoute) {
		if _, ok := got[route.Pattern]; ok {
			t.Fatalf("duplicate %s", route.Pattern)
		}
		got[route.Pattern] = route
	})
	want := map[string]ScopeRoute{}
	add := func(pattern string, route ScopeRoute) { route.Pattern = pattern; want[pattern] = route }
	for _, method := range []string{"GET", "HEAD"} {
		add(method+" /api/v1/me", ScopeRoute{SelfIntrospection: true})
	}
	add("PATCH /api/v1/me", ScopeRoute{Operations: []scopepolicy.Operation{scopepolicy.AccountWrite}})
	add("POST /api/v1/auth/logout", ScopeRoute{BrowserOnly: true})
	add("POST /api/v1/auth/session/activity", ScopeRoute{BrowserOnly: true})
	add("/api/v1/auth/session/activity", ScopeRoute{BrowserOnly: true, Fallback: true})
	add("/api/v1/auth/logout", ScopeRoute{Fallback: true})
	for _, method := range []string{"GET", "HEAD", "POST"} {
		add(method+" /api/v1/me/tokens", ScopeRoute{BrowserOnly: true})
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		add(method+" /api/v1/me/tokens/{tokenId}", ScopeRoute{BrowserOnly: true})
	}
	for _, path := range []string{"/api/v1/me", "/api/v1/me/tokens", "/api/v1/me/tokens/{tokenId}"} {
		add(path, ScopeRoute{Fallback: true})
	}
	for _, method := range []string{"GET", "POST"} {
		add(method+" /api/v2/me/tokens", ScopeRoute{BrowserOnly: true})
	}
	add("HEAD /api/v2/me/tokens", ScopeRoute{BrowserOnly: true, Fallback: true})
	add("/api/v2/me/tokens", ScopeRoute{BrowserOnly: true, Fallback: true})
	add("PATCH /api/v2/me/tokens/{tokenId}/description", ScopeRoute{BrowserOnly: true})
	add("/api/v2/me/tokens/{tokenId}/description", ScopeRoute{BrowserOnly: true, Fallback: true})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scope routes = %#v; want %#v", got, want)
	}
	for pattern, entry := range got {
		method, path, hasMethod := strings.Cut(pattern, " ")
		if !hasMethod {
			method, path = "OPTIONS", pattern
		}
		request := httptest.NewRequest(method, strings.ReplaceAll(path, "{tokenId}", "11111111-1111-4111-8111-111111111111"), nil)
		_, matched := mux.Handler(request)
		expected := pattern
		if strings.HasPrefix(pattern, "HEAD /api/v1/") {
			expected = "GET " + strings.TrimPrefix(pattern, "HEAD ")
		}
		if matched != expected {
			t.Errorf("%s classified %+v, mux matched %q", pattern, entry, matched)
		}
	}
}
