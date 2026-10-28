package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

type legacyWorkerProtocolKey struct{}

// WithLegacyWorkerProtocol restricts task mutations to claims the original worker
// protocol can represent. Restrictions are checked after input validation and
// against the current claim while holding the project's write lock.
func WithLegacyWorkerProtocol(ctx context.Context) context.Context {
	return context.WithValue(ctx, legacyWorkerProtocolKey{}, true)
}

// LegacyWorkerCompatible reports whether the original WorkerClaim representation
// preserves the provider and execution backend without substituting identities.
func LegacyWorkerCompatible(worker *core.WorkerClaim) bool {
	return worker == nil || ((worker.AgentControlMode == "" || worker.AgentControlMode == core.AgentControlModeHerdr) && (worker.Agent == core.AgentCodex || worker.Agent == core.AgentCopilot))
}

func requireCompatibleWorker(ctx context.Context, worker *core.WorkerClaim) error {
	if legacy, _ := ctx.Value(legacyWorkerProtocolKey{}).(bool); legacy && !LegacyWorkerCompatible(worker) {
		return &Fault{Code: "invalid_transition", Message: "This agent or control mode requires a compatible Daynight client. This request did not change the execution."}
	}
	return nil
}
