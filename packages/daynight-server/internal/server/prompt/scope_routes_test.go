package prompt

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestPromptRegistrationReportsScopeClasses(t *testing.T) {
	mux := http.NewServeMux()
	got := map[string]ScopeRoute{}
	RegisterRoutesWithScopeObserver(mux, nil, fakeAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)), func(route ScopeRoute) {
		if _, ok := got[route.Pattern]; ok {
			t.Fatalf("duplicate %s", route.Pattern)
		}
		got[route.Pattern] = route
	})
	want := map[string]ScopeRoute{}
	for _, path := range []string{"/api/v1/me/worker-prompt", "/api/v1/me/projects/{projectId}/worker-prompt", "/api/v1/me/workers/{workerId}/prompt"} {
		for _, method := range []string{"GET", "HEAD"} {
			pattern := method + " " + path
			want[pattern] = ScopeRoute{Pattern: pattern, Operations: []scopepolicy.Operation{scopepolicy.PromptRead}}
		}
		pattern := "PUT " + path
		want[pattern] = ScopeRoute{Pattern: pattern, Operations: []scopepolicy.Operation{scopepolicy.PromptWrite, scopepolicy.PromptRead}}
		want[path] = ScopeRoute{Pattern: path, Fallback: true}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scope routes = %#v; want %#v", got, want)
	}
	for pattern := range got {
		method, path, hasMethod := strings.Cut(pattern, " ")
		if !hasMethod {
			method, path = "OPTIONS", pattern
		}
		path = strings.ReplaceAll(strings.ReplaceAll(path, "{projectId}", "11111111-1111-4111-8111-111111111111"), "{workerId}", "22222222-2222-4222-8222-222222222222")
		_, matched := mux.Handler(httptest.NewRequest(method, path, nil))
		expected := pattern
		if strings.HasPrefix(pattern, "HEAD ") {
			expected = "GET " + strings.TrimPrefix(pattern, "HEAD ")
		}
		if matched != expected {
			t.Errorf("%s matched %q", pattern, matched)
		}
	}
}
