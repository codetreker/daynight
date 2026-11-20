package webhook

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestWebhookRouteClassificationsFollowActualRegistrations(t *testing.T) {
	mux := http.NewServeMux()
	var observed []ScopeRoute
	h := &Routes{service: &fakeService{}, auth: fakeAuth{}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	h.RegisterRoutesWithScopeObserver(mux, func(route ScopeRoute) { observed = append(observed, route) })
	if len(observed) != 65 {
		t.Fatalf("classifications=%d, want 65", len(observed))
	}
	seen := map[string]ScopeRoute{}
	for _, route := range observed {
		key := route.Pattern + " " + route.Method + " " + route.Selector
		if _, ok := seen[key]; ok {
			t.Fatalf("duplicate classification: %+v", route)
		}
		seen[key] = route
		if route.Profile == "credential" {
			if len(route.Operations) != 1 {
				t.Fatalf("missing operation: %+v", route)
			}
			switch route.Operations[0] {
			case scopepolicy.WebhookRead, scopepolicy.WebhookSecret:
				if route.Selector == "rotate" && route.Dynamic != "Service.MutateAuthorized" {
					t.Fatalf("missing rotation owner: %+v", route)
				}
			case scopepolicy.WebhookWrite, scopepolicy.WebhookDelete:
				if route.Dynamic != "Service.MutateAuthorized" {
					t.Fatalf("missing mutation owner: %+v", route)
				}
			case scopepolicy.WebhookDeliver:
				if route.Dynamic != "Service.RedeliverAuthorized" {
					t.Fatalf("missing redelivery owner: %+v", route)
				}
			default:
				t.Fatalf("unknown operation: %+v", route)
			}
		} else if route.Profile != "authenticated-fallback" && route.Profile != "authenticated-not-found" {
			t.Fatalf("unknown profile: %+v", route)
		}
		pattern := route.Pattern
		if _, path, ok := strings.Cut(pattern, " "); ok {
			pattern = path
		}
		endpoint := endpointID
		subresource := "signing-secret"
		if route.Selector == "endpointId=operations" {
			endpoint, subresource = "operations", operationID
		}
		if route.Profile == "authenticated-not-found" {
			subresource = "unrecognized"
		}
		path := strings.NewReplacer("{teamId}", teamID, "{endpointId}", endpoint, "{subresource}", subresource, "{deliveryId}", teamID).Replace(pattern)
		method := route.Method
		if method == "*" {
			method = http.MethodOptions
		}
		req := httptest.NewRequest(method, path, nil)
		_, matched := mux.Handler(req)
		if matched != route.Pattern {
			t.Fatalf("classification %+v matched %q for %s %s", route, matched, method, path)
		}
		if route.Profile != "credential" {
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, req)
			want := http.StatusMethodNotAllowed
			if route.Profile == "authenticated-not-found" {
				want = http.StatusNotFound
			}
			if response.Code != want {
				t.Fatalf("classification %+v status=%d body=%s", route, response.Code, response.Body.String())
			}
		}
	}
	for _, base := range []string{"/api/v1/me/webhooks", "/api/v1/teams/{teamId}/webhooks"} {
		for _, key := range []string{
			base + "/{endpointId} PATCH update", base + "/{endpointId} DELETE delete",
			base + "/{endpointId}/{subresource} GET endpointId=operations", base + "/{endpointId}/{subresource} HEAD endpointId=operations",
			base + "/{endpointId}/{subresource} GET endpointId!=operations,subresource=signing-secret", base + "/{endpointId}/{subresource} HEAD endpointId!=operations,subresource=signing-secret",
			base + "/{endpointId}/{subresource} * known subresource", base + "/{endpointId}/{subresource} * unknown subresource",
			base + "/{endpointId}/deliveries/{deliveryId}/redeliveries POST redeliver",
		} {
			if _, ok := seen[key]; !ok {
				t.Errorf("missing branch %q", key)
			}
		}
		for key, op := range map[string]scopepolicy.Operation{
			"GET " + base + " GET list":                                    scopepolicy.WebhookRead,
			"POST " + base + " POST create":                                scopepolicy.WebhookWrite,
			base + "/{endpointId} GET get":                                 scopepolicy.WebhookRead,
			base + "/{endpointId} PATCH update":                            scopepolicy.WebhookWrite,
			base + "/{endpointId} DELETE delete":                           scopepolicy.WebhookDelete,
			base + "/{endpointId}/{subresource} GET endpointId=operations": scopepolicy.WebhookRead,
			base + "/{endpointId}/{subresource} GET endpointId!=operations,subresource=signing-secret": scopepolicy.WebhookSecret,
			base + "/{endpointId}/deliveries/{deliveryId}/redeliveries POST redeliver":                 scopepolicy.WebhookDeliver,
			"POST " + base + "/{endpointId}/signing-secret/rotations POST rotate":                      scopepolicy.WebhookSecret,
		} {
			entry, ok := seen[key]
			if !ok || !reflect.DeepEqual(entry.Operations, []scopepolicy.Operation{op}) {
				t.Errorf("classification %q = %+v, want %s", key, entry, op)
			}
		}
	}

	scoped := map[string]ScopeRoute{}
	auth := model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: userID, CredentialID: teamID}, Profile: model.SessionProfile}
	if err := RegisterScopedRoutes(http.NewServeMux(), &testScopedService{}, testScopedAuth{auth}, h.logger, func(route ScopeRoute) {
		scoped[route.Pattern+" "+route.Method+" "+route.Selector] = route
	}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(scoped, seen) {
		t.Fatal("scoped registration differs from production classifications")
	}
}
