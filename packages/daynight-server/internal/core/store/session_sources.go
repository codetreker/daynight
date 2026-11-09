package store

import "context"

// SessionSourceHash preserves the exact original event or batch identity across
// relay restarts. A source acknowledgement never relies on an in-memory cache.
type SessionSourceHash struct {
	Through                                int64
	SessionID, SourceEpoch, Kind, Identity string
	Digest                                 []byte
}
type SessionSourceDAO interface {
	SessionSourceHash(context.Context, SessionSourceHash) ([]byte, error)
	SaveSessionSourceHash(context.Context, SessionSourceHash) error
}
