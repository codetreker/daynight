package attachment

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestAttachmentRegistrationReportsHostScopeClasses(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	const base = "/api/v1/projects/{projectId}/tasks/{taskId}"
	main := map[string]ScopeRoute{}
	for _, path := range []string{base + "/attachments", base + "/attachments/files/{path...}"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			pattern := method + " " + path
			main[pattern] = ScopeRoute{Pattern: pattern, Operations: []scopepolicy.Operation{scopepolicy.AttachmentRead}}
		}
		main[path] = ScopeRoute{Pattern: path, Fallback: true}
	}
	file := base + "/attachments/files/{path...}"
	main["PUT "+file] = ScopeRoute{Pattern: "PUT " + file, Operations: []scopepolicy.Operation{scopepolicy.AttachmentUpload, scopepolicy.AttachmentRead}}
	main["DELETE "+file] = ScopeRoute{Pattern: "DELETE " + file, Operations: []scopepolicy.Operation{scopepolicy.AttachmentDelete}}
	preview := base + "/preview/{path...}"
	main["GET "+preview] = ScopeRoute{Pattern: "GET " + preview, PublicNavigation: true}
	main["HEAD "+preview] = ScopeRoute{Pattern: "HEAD " + preview, Operations: []scopepolicy.Operation{scopepolicy.AttachmentRead}}
	main[preview] = ScopeRoute{Pattern: preview, Fallback: true}
	cookie := map[string]ScopeRoute{
		"GET " + preview:  {Pattern: "GET " + preview, PreviewCookieOnly: true},
		"HEAD " + preview: {Pattern: "HEAD " + preview, PreviewCookieOnly: true},
		preview:           {Pattern: preview, PreviewCookieOnly: true, Fallback: true},
	}
	for _, test := range []struct {
		host     string
		want     map[string]ScopeRoute
		register func(*http.ServeMux, func(ScopeRoute))
	}{
		{"main", main, func(mux *http.ServeMux, observe func(ScopeRoute)) {
			RegisterRoutesWithScopeObserver(mux, nil, &authhttp.Authentication{}, logger, "https://preview.daynight.test", observe)
		}},
		{"scoped main", main, func(mux *http.ServeMux, observe func(ScopeRoute)) {
			RegisterScopedRoutesWithScopeObserver(mux, &scopedOperations{}, &scopedAuthentication{}, logger, "https://preview.daynight.test", observe)
		}},
		{"preview Cookie", cookie, func(mux *http.ServeMux, observe func(ScopeRoute)) {
			RegisterPreviewRoutesWithScopeObserver(mux, nil, func(next httpx.AuthenticatedHandler) http.HandlerFunc {
				return func(http.ResponseWriter, *http.Request) { t.Fatal("registration executed preview authentication") }
			}, logger, observe)
		}},
	} {
		t.Run(test.host, func(t *testing.T) {
			mux := http.NewServeMux()
			got := map[string]ScopeRoute{}
			test.register(mux, func(route ScopeRoute) {
				if _, duplicate := got[route.Pattern]; duplicate {
					t.Fatalf("duplicate route: %s", route.Pattern)
				}
				got[route.Pattern] = route
			})
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("host registration: %#v; want %#v", got, test.want)
			}
			for pattern := range got {
				method, path, hasMethod := strings.Cut(pattern, " ")
				if !hasMethod {
					method, path = http.MethodOptions, pattern
				}
				path = strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(path, "{projectId}", scopedProject), "{taskId}", scopedTask), "{path...}", "docs/file.txt")
				_, matched := mux.Handler(httptest.NewRequest(method, path, nil))
				want := pattern
				if method == http.MethodHead {
					want = "GET " + strings.TrimPrefix(pattern, "HEAD ")
				}
				if matched != want {
					t.Errorf("%s matched %q; want %q", pattern, matched, want)
				}
			}
		})
	}
}
