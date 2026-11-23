package mcp

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mcpOrgGoalDependencies struct {
	t             *testing.T
	lock, inspect func()
}

func mcpOrgEmptyGoalDependencies(t *testing.T, inspect bool) store.ProjectGoalDependencyDAO {
	n := 0
	if inspect {
		n = 1
	}
	return mcpOrgGoalDependencies{t: t, lock: mcpOrgCount(t, 0), inspect: mcpOrgCount(t, n)}
}
func (d mcpOrgGoalDependencies) LockTeam(context.Context) error { d.lock(); return nil }
func (d mcpOrgGoalDependencies) HasProjectEdges(context.Context) (bool, error) {
	d.inspect()
	return false, nil
}
func (d mcpOrgGoalDependencies) RemoveProjectEdges(context.Context) error {
	unexpectedHTTPCall(d.t, "MCP unconfirmed Project Goal cleanup")
	return nil
}
