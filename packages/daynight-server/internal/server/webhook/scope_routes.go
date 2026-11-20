package webhook

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeRoute identifies a method and, where a handler dispatches internally,
// the selected branch of one actual ServeMux registration. Dynamic identifies
// the domain entry responsible for selecting additional scopes from the request.
type ScopeRoute struct {
	Pattern, Method, Selector, Dynamic, Profile string
	Operations                                  []scopepolicy.Operation
}

type routeRegistry struct {
	mux     httpx.RouteRegistrar
	observe func(ScopeRoute)
}

func readBranch(selector string) ScopeRoute {
	return ScopeRoute{Selector: selector, Profile: "credential", Operations: []scopepolicy.Operation{scopepolicy.WebhookRead}}
}

func secretBranch(selector string) ScopeRoute {
	return ScopeRoute{Selector: selector, Profile: "credential", Operations: []scopepolicy.Operation{scopepolicy.WebhookSecret}}
}

func mutationBranch(selector string, op scopepolicy.Operation) ScopeRoute {
	return ScopeRoute{Selector: selector, Profile: "credential", Operations: []scopepolicy.Operation{op}, Dynamic: "Service.MutateAuthorized"}
}

func fallbackBranch(selector string) ScopeRoute {
	return ScopeRoute{Method: "*", Selector: selector, Profile: "authenticated-fallback"}
}

func notFoundBranch(selector string) ScopeRoute {
	return ScopeRoute{Method: "*", Selector: selector, Profile: "authenticated-not-found"}
}

func methodBranch(method string, route ScopeRoute) ScopeRoute {
	route.Method = method
	return route
}

func (r routeRegistry) handle(pattern string, handler http.HandlerFunc, branches ...ScopeRoute) {
	if len(branches) == 0 {
		panic("unclassified webhook route")
	}
	method, _, hasMethod := strings.Cut(pattern, " ")
	for _, branch := range branches {
		if branch.Profile == "" || (branch.Profile == "credential" && len(branch.Operations) == 0) || (branch.Profile != "credential" && len(branch.Operations) != 0) {
			panic("invalid webhook route classification")
		}
		if hasMethod {
			if branch.Method != "" {
				panic("method specified twice")
			}
			branch.Method = method
		} else if branch.Method == "" {
			panic("missing webhook route method")
		}
	}
	r.mux.HandleFunc(pattern, handler)
	if r.observe == nil {
		return
	}
	for _, branch := range branches {
		branch.Pattern = pattern
		if hasMethod {
			branch.Method = method
		}
		r.observe(branch)
		if hasMethod && method == http.MethodGet {
			branch.Method = http.MethodHead
			r.observe(branch)
		}
	}
}
