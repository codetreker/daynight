package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Only the deletion-completion scope exposes the media cleanup capability.
// Calls still pass through the exact shared script and its argument checks.
type mcpBotResourceSessionDAO struct {
	*mcpBotSessionDAO
	store.SessionResourceDAO
}

func (d *mcpBotResourceSessionDAO) SessionResourceUsage(_ context.Context, id string) (store.SessionResourceUsage, error) {
	r := d.s.call("SessionResourceUsage", id)
	return r[0].(store.SessionResourceUsage), mcpBotErr(r[1])
}
func (d *mcpBotResourceSessionDAO) BeginSessionResourceDeletion(_ context.Context, id string) (int64, error) {
	r := d.s.call("BeginSessionResourceDeletion", id)
	return r[0].(int64), mcpBotErr(r[1])
}
func (d *mcpBotResourceSessionDAO) ListSessionResourceLeases(_ context.Context, id string) ([]store.SessionResourceLease, error) {
	r := d.s.call("ListSessionResourceLeases", id)
	return r[0].([]store.SessionResourceLease), mcpBotErr(r[1])
}
