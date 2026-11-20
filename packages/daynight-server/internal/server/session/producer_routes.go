package session

import (
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ProducerRoute describes an actual producer registration. Fixed Controller
// tokens retain their own protocol and are rechecked against their parent.
type ProducerRoute struct {
	Pattern            string
	Operations         []scopepolicy.Operation
	IndependentProfile bool
	Fallback           bool
}

type producerRouteClass uint8

const (
	producerCredential producerRouteClass = iota
	producerIndependent
	producerFallback
)

func registerProducerRoute(mux *http.ServeMux, pattern string, handler http.HandlerFunc, class producerRouteClass, observe func(ProducerRoute)) {
	entry := ProducerRoute{Pattern: pattern}
	switch class {
	case producerCredential:
		entry.Operations = []scopepolicy.Operation{scopepolicy.SessionProduce}
	case producerIndependent:
		entry.IndependentProfile = true
	case producerFallback:
		entry.Fallback = true
	default:
		panic("unclassified Session producer route")
	}
	mux.HandleFunc(pattern, handler)
	if observe != nil {
		observe(entry)
		if strings.HasPrefix(pattern, "GET ") && pattern != "GET /api/v1/controller-channel" {
			entry.Pattern = "HEAD " + strings.TrimPrefix(pattern, "GET ")
			observe(entry)
		}
	}
}
