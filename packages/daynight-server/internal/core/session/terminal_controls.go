package session

import (
	"context"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

type terminalFrameWrite struct {
	projectID    string
	raw          []byte
	fence        v2.Envelope
	epoch, owner string
	lastSeen     time.Time
}

// Ordering is durable independently of preview publication. The frame hash
// permits exact retries without retaining terminal text in PostgreSQL.
type terminalFrameIdentity struct {
	ExecutionGeneration string
	SegmentID           string
	FrameSeq            string
	SHA256              string
}

func (s *Execution) forgetTerminalSnapshot(id string) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	delete(s.terminalFrames, id)
	delete(s.terminalFrameWrites, id)
}

func invalidateTerminalOperations(ctx context.Context, tx *operationTx, id string) error {
	return tx.dao.InvalidateTerminalOperations(ctx, id)
}
