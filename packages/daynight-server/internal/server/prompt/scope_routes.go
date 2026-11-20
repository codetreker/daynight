package prompt

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeRoute records the classification attached to a prompt route registration.
type ScopeRoute struct {
	Pattern    string
	Operations []scopepolicy.Operation
	Fallback   bool
}

type routeClass int

const (
	routeRead routeClass = iota
	routeWrite
	routeFallback
)

type routeRegistry struct {
	mux     httpx.RouteRegistrar
	observe func(ScopeRoute)
}

func (r routeRegistry) handle(pattern string, handler http.HandlerFunc, class routeClass) {
	entry := ScopeRoute{Pattern: pattern}
	switch class {
	case routeRead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.PromptRead}
	case routeWrite:
		entry.Operations = []scopepolicy.Operation{scopepolicy.PromptWrite, scopepolicy.PromptRead}
	case routeFallback:
		entry.Fallback = true
	default:
		panic("unclassified prompt route")
	}
	r.mux.HandleFunc(pattern, handler)
	if r.observe != nil {
		r.observe(entry)
		if strings.HasPrefix(pattern, "GET ") {
			entry.Pattern = "HEAD " + strings.TrimPrefix(pattern, "GET ")
			r.observe(entry)
		}
	}
}
