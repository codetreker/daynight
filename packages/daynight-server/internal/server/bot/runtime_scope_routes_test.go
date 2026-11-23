package bot

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
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
)

func TestRuntimeAndRecoveryRegistrationsClassifyActualRoutes(t *testing.T) {
	mux := http.NewServeMux()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth := &authhttp.Authentication{RequestAuthentication: &authhttp.RequestAuthentication{}}
	responses := sessionhttp.NewRoutes(nil, auth, logger)
	got := map[string]RuntimeScopeRoute{}
	observe := func(route RuntimeScopeRoute) {
		if _, ok := got[route.Pattern]; ok {
			t.Fatalf("duplicate route classification %q", route.Pattern)
		}
		got[route.Pattern] = route
	}
	RegisterRuntimeRoutesWithScopeObserver(mux, nil, nil, auth, responses, logger, observe)
	RegisterRecoveryRoutesWithScopeObserver(mux, nil, auth, responses, logger, observe)
	base := "/api/v1/me/workers/{workerId}/bots/{botId}/"
	want := map[string]RuntimeScopeRoute{}
	add := func(path string, route RuntimeScopeRoute) {
		route.Pattern = "POST " + path
		want[route.Pattern] = route
		want[path] = RuntimeScopeRoute{Pattern: path, Fallback: true}
	}
	possible := []scopepolicy.Operation{scopepolicy.SessionProduce}
	add(base+"register", RuntimeScopeRoute{DynamicOwner: "bot-session-registration", PossibleOperations: possible})
	add(base+"grant", RuntimeScopeRoute{Operations: possible})
	add(base+"report", RuntimeScopeRoute{DynamicOwner: "bot-runtime-report", PossibleOperations: possible})
	add(base+"deletion-complete", RuntimeScopeRoute{DynamicOwner: "bot-deletion-completion"})
	for _, action := range []string{"register", "takeover", "grant"} {
		add(base+"recovery/v1/"+action, RuntimeScopeRoute{DynamicOwner: "bot-recovery-write-or-receipt", PossibleOperations: possible})
	}
	add(base+"recovery/v1/report", RuntimeScopeRoute{DynamicOwner: "bot-recovery-report", PossibleOperations: possible})
	add(base+"recovery/v1/operations/{operationId}", RuntimeScopeRoute{DynamicOwner: "bot-recovery-receipt"})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("runtime classifications = %#v; want %#v", got, want)
	}
	for pattern := range got {
		method, path, hasMethod := strings.Cut(pattern, " ")
		if !hasMethod {
			method, path = "HEAD", pattern
		}
		for _, key := range []string{"workerId", "botId", "operationId"} {
			path = strings.ReplaceAll(path, "{"+key+"}", "11111111-1111-4111-8111-111111111111")
		}
		_, matched := mux.Handler(httptest.NewRequest(method, path, nil))
		if matched != pattern {
			t.Errorf("%s matched %q", pattern, matched)
		}
	}
}
