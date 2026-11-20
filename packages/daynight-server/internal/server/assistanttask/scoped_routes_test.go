package assistanttask

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
)

func scopedHandler(t *testing.T, resolve AuthorizationResolver, call func(context.Context, core.Actor, string, ...any) (any, error), record func(RouteClassification)) *http.ServeMux {
	return scopedHandlerWithOperations(t, resolve, &operationMock{call: call}, record)
}

func scopedHandlerWithOperations(t *testing.T, resolve AuthorizationResolver, ops operations, record func(RouteClassification)) *http.ServeMux {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if kind != model.PATCredential || secret != "secret" {
			return model.Principal{}, authhttp.Failure()
		}
		return testPrincipal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if record == nil {
		record = func(RouteClassification) {}
	}
	if err = RegisterScopedRoutes(mux, ops, auth, logger, resolve, record); err != nil {
		t.Fatal(err)
	}
	return mux
}

func scopedAuthorization(t *testing.T) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"assistant-task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: testPrincipal, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedRoutesForwardAuthorizationAndDeletion(t *testing.T) {
	authorization := scopedAuthorization(t)
	calls := 0
	h := scopedHandler(t, func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		if p != testPrincipal {
			t.Fatal("principal changed")
		}
		return authorization, nil
	}, func(_ context.Context, actor core.Actor, name string, args ...any) (any, error) {
		calls++
		input := args[0].(core.UpdateInput)
		if name != "Update" || actor.Authorization == nil || *actor.Authorization != authorization || input.State == nil || *input.State != "deleted" {
			t.Fatalf("actor=%+v name=%s input=%+v", actor, name, input)
		}
		return nil, scopepolicy.ErrInsufficientScope
	}, nil)
	for _, tc := range []struct{ method, body string }{
		{"PATCH", `{"ifVersion":"4","state":"deleted"}`},
		{"DELETE", `{"ifVersion":"4"}`},
	} {
		response := request(h, tc.method, taskPath, tc.body, false)
		assertError(t, response, http.StatusForbidden, "forbidden")
		if response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || !strings.Contains(response.Body.String(), "insufficient scope") {
			t.Fatalf("header=%v body=%s", response.Header(), response.Body)
		}
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestScopedRoutesRejectBadProfileAndPreserveUnknownCompletion(t *testing.T) {
	authorization := scopedAuthorization(t)
	for _, tc := range []struct {
		name    string
		resolve AuthorizationResolver
	}{
		{"missing", func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
			return model.CredentialAuthorization{}, nil
		}},
		{"wrong principal", func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
			a := authorization
			a.Principal.UserID = testID
			return a, nil
		}},
		{"error", func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
			return model.CredentialAuthorization{}, errors.New("resolver failed")
		}},
		{"scope from resolver", func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
			return model.CredentialAuthorization{}, scopepolicy.ErrInsufficientScope
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := scopedHandler(t, tc.resolve, func(context.Context, core.Actor, string, ...any) (any, error) {
				t.Fatal("business operation called")
				return nil, nil
			}, nil)
			response := request(h, "GET", taskPath, "", false)
			if response.Code != http.StatusInternalServerError || response.Header().Get("Daynight-Scope-Status") != "" {
				t.Fatalf("status=%d header=%v body=%s", response.Code, response.Header(), response.Body)
			}
		})
	}
	h := scopedHandler(t, func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		return authorization, nil
	}, func(context.Context, core.Actor, string, ...any) (any, error) {
		return inboxResult(inboxToken), &service.WriteError{Operation: "EnableInbox", Outcome: store.TransactionUnknown, Cause: scopepolicy.ErrInsufficientScope}
	}, nil)
	response := request(h, "POST", inboxPath+"/enable", `{"operationId":"`+testOperation+`","ifVersion":"1"}`, false)
	assertError(t, response, http.StatusServiceUnavailable, "write_outcome_unknown")
	if strings.Contains(response.Body.String(), inboxToken) || response.Header().Get("Daynight-Scope-Status") != "" {
		t.Fatalf("header=%v body=%s", response.Header(), response.Body)
	}
}

func TestScopedInboxTokenOnlyInAuthorizedResponse(t *testing.T) {
	authorization := scopedAuthorization(t)
	calls := 0
	h := scopedHandler(t, func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		return authorization, nil
	}, func(_ context.Context, actor core.Actor, name string, _ ...any) (any, error) {
		if actor.Authorization == nil || *actor.Authorization != authorization {
			t.Fatal("missing scoped authorization")
		}
		calls++
		switch name {
		case "EnableInbox", "InboxOperation":
			return inboxResult(inboxToken), nil
		default:
			t.Fatalf("unexpected operation %s", name)
			return nil, nil
		}
	}, nil)
	response := request(h, "POST", inboxPath+"/enable", `{"operationId":"`+testOperation+`","ifVersion":"1"}`, false)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), inboxToken) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	response = request(h, "GET", taskPath+"/inbox-operations/"+testOperation, "", false)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), inboxToken) || calls != 2 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, calls, response.Body)
	}
}

func TestRegisteredScopedRoutesClassifyActualPatterns(t *testing.T) {
	authorization := scopedAuthorization(t)
	var registrations []RouteClassification
	record := func(v RouteClassification) { registrations = append(registrations, v) }
	h := scopedHandler(t, func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		return authorization, nil
	}, func(context.Context, core.Actor, string, ...any) (any, error) { return nil, nil }, record)
	RegisterClassifiedInboxRoute(h, nil, record)
	seen := map[string]RouteClassification{}
	for _, route := range registrations {
		key := route.Pattern + " " + route.Method
		if route.Host != "" || route.Pattern == "" || route.Method == "" || route.Owner == "" || seen[key].Method != "" {
			t.Fatalf("bad registration: %+v", route)
		}
		seen[key] = route
		if route.Profile == "credential" {
			contract, ok := core.ScopeContractFor(route.Owner)
			if !ok || route.Contract == nil || !reflect.DeepEqual(*route.Contract, contract) || len(route.Branches) == 0 {
				t.Fatalf("unclassified route: %+v", route)
			}
			for _, selected := range route.Branches {
				found := false
				for _, branch := range contract.Branches {
					if branch.Name == selected && len(branch.Operations) > 0 {
						found = true
					}
				}
				if !found {
					t.Fatalf("unknown branch %q for %+v", selected, route)
				}
			}
		}
		path := strings.NewReplacer("{taskId}", testTask, "{id}", testID, "{manualVersion}", "2", "{inboxId}", testID).Replace(route.Pattern)
		method := route.Method
		if method == "*" {
			method = http.MethodOptions
		}
		req := httptest.NewRequest(method, path, nil)
		_, pattern := h.Handler(req)
		if pattern != route.Pattern {
			t.Fatalf("route %+v matched %q", route, pattern)
		}
		if route.Method == "*" {
			if route.Owner != "method-fallback" {
				t.Fatalf("fallback=%+v", route)
			}
			if route.Pattern != "/api/v1/assistant-task-inbox/{inboxId}" {
				req.Header.Set("Authorization", "Bearer secret")
			}
			response := httptest.NewRecorder()
			h.ServeHTTP(response, req)
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatalf("fallback %+v status=%d", route, response.Code)
			}
		}
	}
	for _, route := range seen {
		if route.Method == http.MethodGet {
			head := seen[route.Pattern+" "+http.MethodHead]
			if head.Owner != route.Owner || !reflect.DeepEqual(head.Contract, route.Contract) || !reflect.DeepEqual(head.Branches, route.Branches) {
				t.Fatalf("missing HEAD for %+v", route)
			}
		}
	}
	if got := seen["/api/v1/assistant-task-inbox/{inboxId} POST"]; got.Profile != "inbox-token-or-daynight-delivery" {
		t.Fatal("missing public inbox profile")
	}
	if got := seen["/api/v1/assistant-tasks/{taskId} DELETE"]; !reflect.DeepEqual(got.Branches, []string{"response", "delete"}) {
		t.Fatalf("DELETE branches=%v", got.Branches)
	}
	if got := seen["/api/v1/assistant-tasks/{taskId}/appendix/{id} DELETE"]; !reflect.DeepEqual(got.Branches, []string{"delete"}) {
		t.Fatalf("appendix DELETE branches=%v", got.Branches)
	}
}
