package usage

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeRoute describes one registered usage endpoint. Producer identifies the
// existing restricted ingress in addition to its business operation; grant
// endpoints use their own token and retain their original parent binding.
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
	mux     httpx.RouteRegistrar
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
		entry.Operations = []scopepolicy.Operation{scopepolicy.SessionProduce}
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
