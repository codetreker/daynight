package usage

import (
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeRoute describes one registered usage endpoint. Producer operations are
// classified separately from user reads; grant endpoints use their own token.
type ScopeRoute struct {
	Pattern            string
	Operations         []scopepolicy.Operation
	CapabilityCheck    bool
	Producer           bool
	IndependentProfile bool
}

type routeClass int

const (
	routeRead routeClass = iota
	routeCapability
	routeProducer
	routeGrant
)

type routeRegistry struct {
	mux     *http.ServeMux
	observe func(ScopeRoute)
}

func (r routeRegistry) handle(pattern string, handler http.HandlerFunc, class routeClass) {
	entry := ScopeRoute{Pattern: pattern}
	switch class {
	case routeRead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.UsageRead}
	case routeCapability:
		entry.CapabilityCheck = true
	case routeProducer:
		entry.Producer = true
	case routeGrant:
		entry.IndependentProfile = true
	default:
		panic("unclassified usage route")
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
