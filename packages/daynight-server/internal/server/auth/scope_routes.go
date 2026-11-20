package auth

import (
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeRoute records the classification attached to an account route registration.
type ScopeRoute struct {
	Pattern           string
	Operations        []scopepolicy.Operation
	SelfIntrospection bool
	BrowserOnly       bool
	Fallback          bool
}

type accountRouteClass int

const (
	accountSelf accountRouteClass = iota
	accountWrite
	accountBrowser
	accountFallback
	accountBrowserFallback
)

type accountRouteRegistry struct {
	mux     *http.ServeMux
	observe func(ScopeRoute)
}

func (r accountRouteRegistry) handle(pattern string, handler http.HandlerFunc, class accountRouteClass, autoHEAD bool) {
	entry := ScopeRoute{Pattern: pattern}
	switch class {
	case accountSelf:
		entry.SelfIntrospection = true
	case accountWrite:
		entry.Operations = []scopepolicy.Operation{scopepolicy.AccountWrite}
	case accountBrowser:
		entry.BrowserOnly = true
	case accountFallback:
		entry.Fallback = true
	case accountBrowserFallback:
		entry.BrowserOnly, entry.Fallback = true, true
	default:
		panic("unclassified account route")
	}
	r.mux.HandleFunc(pattern, handler)
	if r.observe != nil {
		r.observe(entry)
		if autoHEAD && strings.HasPrefix(pattern, "GET ") {
			entry.Pattern = "HEAD " + strings.TrimPrefix(pattern, "GET ")
			r.observe(entry)
		}
	}
}
