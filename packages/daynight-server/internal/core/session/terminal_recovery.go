package session

import v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"

type terminalAutomationRecovery struct {
	State       v2.AutomationRecoveryState
	Invalidated bool
}

func invalidateAutomationRecoveries(r *terminalRecord) {
	for _, permit := range r.AutomationRecoveries {
		if permit.State.Consumed == nil {
			permit.Invalidated = true
		}
	}
}
