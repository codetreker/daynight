package bot

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// RuntimeScopeRoute records an actual runtime or recovery route registration.
// DynamicOwner identifies the service branch that decides admission after
// validating the original resource and any existing receipt. PossibleOperations
// describes requirements used by some branches, not an unconditional guard.
// Registration checks the actor for a new Session; recovery writes check the
// actor only after looking up an existing receipt. Reports recheck producer
// parents at their actual lifecycle boundaries. Recovery receipt lookup keeps
// its existing identity and ownership checks.
type RuntimeScopeRoute struct {
	Pattern            string
	Operations         []scopepolicy.Operation
	PossibleOperations []scopepolicy.Operation
	DynamicOwner       string
	Fallback           bool
}

type runtimeRouteClass int

const (
	runtimeProducer runtimeRouteClass = iota
	runtimeRegister
	runtimeReport
	runtimeDeletionComplete
	recoveryWrite
	recoveryReport
	recoveryReceipt
	runtimeFallback
)

type runtimeRouteRegistry struct {
	mux     *http.ServeMux
	observe func(RuntimeScopeRoute)
}

func (r runtimeRouteRegistry) handle(pattern string, handler http.HandlerFunc, class runtimeRouteClass) {
	entry := RuntimeScopeRoute{Pattern: pattern}
	switch class {
	case runtimeProducer:
		entry.Operations = []scopepolicy.Operation{scopepolicy.SessionProduce}
	case runtimeRegister:
		entry.DynamicOwner = "bot-session-registration"
		entry.PossibleOperations = []scopepolicy.Operation{scopepolicy.SessionProduce}
	case runtimeReport:
		entry.DynamicOwner = "bot-runtime-report"
		entry.PossibleOperations = []scopepolicy.Operation{scopepolicy.SessionProduce}
	case runtimeDeletionComplete:
		entry.DynamicOwner = "bot-deletion-completion"
	case recoveryWrite:
		entry.DynamicOwner = "bot-recovery-write-or-receipt"
		entry.PossibleOperations = []scopepolicy.Operation{scopepolicy.SessionProduce}
	case recoveryReport:
		entry.DynamicOwner = "bot-recovery-report"
		entry.PossibleOperations = []scopepolicy.Operation{scopepolicy.SessionProduce}
	case recoveryReceipt:
		entry.DynamicOwner = "bot-recovery-receipt"
	case runtimeFallback:
		entry.Fallback = true
	default:
		panic("unclassified Bot runtime route")
	}
	r.mux.HandleFunc(pattern, handler)
	if r.observe != nil {
		r.observe(entry)
	}
}
