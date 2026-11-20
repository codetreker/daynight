package store

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// BotObservationSource contains the current host and bound Session in the
// caller's snapshot. Worker age does not remove its last confirmed location.
type BotObservationSource struct {
	Worker  *model.WorkerSnapshot
	Session *BotSessionSource
}

// BotSessionSource retains durable identity and lease facts, not live activity
// or synchronization. Snapshot contains only its fence, identity and lifecycle.
type BotSessionSource struct {
	Snapshot         sp.Snapshot
	LastSeen         *time.Time
	ConnectionExpiry *time.Time
	ServerInstance   string
}

// BotSessionLive describes only a matching live Session observation. Available
// does not grant input permission; command admission retains its own checks.
type BotSessionLive struct {
	ObservedAt      time.Time
	Fence           sp.ControllerFence
	ConnectionState string
	Synchronized    bool
	SourceSynced    bool
	Activity        string
	CurrentTurnID   *string
	Available       bool
}
