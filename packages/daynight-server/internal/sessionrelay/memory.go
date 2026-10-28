package sessionrelay

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
)

const maxLiveSessions = 64
const maxLiveBytes = 4 * 1024 * 1024
const maxEventBytes = 2 * 1024 * 1024
const maxSessionOperations = 4096

// Live content belongs to the connected controller. PostgreSQL stores only the
// control ledger; reconnect replaces the cache, and only expired, unlocked slots are reclaimed.
type timelineVersion struct {
	Sequence string
	Revision string
	Hash     [32]byte
}
type liveSession struct {
	LastSeen            *time.Time
	Snapshot            sp.Snapshot
	Events              []json.RawMessage
	EventBytes          int
	MinEventSeq         int64
	Commands            map[string]sp.Command
	PendingInteractions map[string]sp.TimelineEntry
	SourceHashes        map[int64][32]byte
	SourceOrder         []int64
	BatchHashes         map[string][32]byte
	BatchOrder          []string
	Synced              bool
	TimelineVersions    map[string]timelineVersion
	TimelineOrder       []string
}
type liveCell struct {
	mu    sync.Mutex
	value *liveSession
}
type relayTx struct {
	pgx.Tx
	service   *Service
	cells     map[string]*liveCell
	live      map[string]*liveSession
	committed []func()
}

func cloneLive(v *liveSession) *liveSession {
	if v == nil {
		return nil
	}
	out := *v
	out.TimelineVersions = make(map[string]timelineVersion, len(v.TimelineVersions))
	for k, x := range v.TimelineVersions {
		out.TimelineVersions[k] = x
	}
	out.TimelineOrder = append([]string(nil), v.TimelineOrder...)
	out.Events = append([]json.RawMessage(nil), v.Events...)
	out.Commands = make(map[string]sp.Command, len(v.Commands))
	for k, x := range v.Commands {
		out.Commands[k] = x
	}
	out.PendingInteractions = make(map[string]sp.TimelineEntry, len(v.PendingInteractions))
	for k, x := range v.PendingInteractions {
		out.PendingInteractions[k] = x
	}
	out.SourceHashes = make(map[int64][32]byte, len(v.SourceHashes))
	for k, x := range v.SourceHashes {
		out.SourceHashes[k] = x
	}
	out.SourceOrder = append([]int64(nil), v.SourceOrder...)
	out.BatchHashes = make(map[string][32]byte, len(v.BatchHashes))
	for k, x := range v.BatchHashes {
		out.BatchHashes[k] = x
	}
	out.BatchOrder = append([]string(nil), v.BatchOrder...)
	return &out
}
func newLive(v sp.Snapshot) *liveSession {
	return &liveSession{Snapshot: v, TimelineVersions: map[string]timelineVersion{}, MinEventSeq: number(v.LastEventSeq), Commands: map[string]sp.Command{}, PendingInteractions: map[string]sp.TimelineEntry{}, SourceHashes: map[int64][32]byte{}, BatchHashes: map[string][32]byte{}}
}
func (tx *relayTx) content(id string, create bool) (*liveSession, error) {
	if v, ok := tx.live[id]; ok {
		return v, nil
	}
	s := tx.service
	s.liveMutex.Lock()
	cell := s.live[id]
	if cell == nil && create {
		if len(s.live) >= maxLiveSessions {
			for key, candidate := range s.live {
				if candidate.mu.TryLock() {
					stale := candidate.value == nil || candidate.value.LastSeen == nil || s.now().Sub(*candidate.value.LastSeen) > HeartbeatTimeout
					if stale {
						delete(s.live, key)
					}
					candidate.mu.Unlock()
					if len(s.live) < maxLiveSessions {
						break
					}
				}
			}
		}
		if len(s.live) >= maxLiveSessions {
			s.liveMutex.Unlock()
			return nil, fault("rate_limited", "Live session capacity is unavailable.")
		}
		cell = &liveCell{}
		s.live[id] = cell
	}
	if cell == nil {
		s.liveMutex.Unlock()
		return nil, nil
	}
	cell.mu.Lock()
	s.liveMutex.Unlock()
	tx.cells[id] = cell
	tx.live[id] = cloneLive(cell.value)
	return tx.live[id], nil
}
func (s *Service) transact(ctx context.Context, fn func(pgx.Tx) error) error {
	native, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	tx := &relayTx{Tx: native, service: s, cells: map[string]*liveCell{}, live: map[string]*liveSession{}}
	committed := false
	defer func() {
		_ = native.Rollback(context.Background())
		for id, cell := range tx.cells {
			if committed {
				cell.value = tx.live[id]
			}
			cell.mu.Unlock()
		}
		if committed {
			for _, fn := range tx.committed {
				fn()
			}
		}
	}()
	if err = fn(tx); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fault("not_found", "Session was not found.")
		}
		return err
	}
	if err = native.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}
func attachLive(tx pgx.Tx, r *record) error {
	rt, ok := tx.(*relayTx)
	if !ok {
		return nil
	}
	live, err := rt.content(r.Snapshot.SessionID, false)
	if err != nil {
		return err
	}
	r.Live = live
	if live != nil && live.Snapshot.ControllerFence == r.Snapshot.ControllerFence {
		stable := r.Snapshot
		r.Snapshot = live.Snapshot
		r.Snapshot.Lifecycle = stable.Lifecycle
		r.Snapshot.InitialInputState = stable.InitialInputState
	} else {
		r.Snapshot.ConnectionState = "disconnected"
		r.Snapshot.Synchronized = false
		r.Snapshot.Activity = "unknown"
	}
	return nil
}
func createLive(tx pgx.Tx, r *record) error {
	rt, ok := tx.(*relayTx)
	if !ok {
		return fault("controller_offline", "Live relay state is unavailable.")
	}
	if _, err := rt.content(r.Snapshot.SessionID, true); err != nil {
		return err
	}
	r.Live = newLive(r.Snapshot)
	rt.live[r.Snapshot.SessionID] = r.Live
	return nil
}

// Stable control identity is deliberately enumerated. Adding display fields to
// Snapshot must never make conversation data persistent as an accidental side effect.
func durableSnapshot(v sp.Snapshot) sp.Snapshot {
	return sp.Snapshot{ControllerFence: v.ControllerFence, Protocol: v.Protocol, SchemaVersion: v.SchemaVersion, ProjectionVersion: v.ProjectionVersion, Identity: v.Identity, SessionRevision: v.SessionRevision, HistoryEpoch: v.HistoryEpoch, LastEventSeq: v.LastEventSeq, LastTimelineSeq: v.LastTimelineSeq, InitialInputState: v.InitialInputState, Lifecycle: v.Lifecycle, ConnectionState: "disconnected", Activity: "unknown"}
}
func durableOperation(v sp.Operation) sp.Operation { v.Error = nil; return v }
func (v *liveSession) checkCapacity() error {
	n := v.EventBytes
	for _, value := range []any{v.Snapshot, v.Commands, v.PendingInteractions} {
		raw, err := sp.MarshalWire(value)
		if err != nil {
			return err
		}
		n += len(raw)
	}
	if n > maxLiveBytes || len(v.PendingInteractions) > 100 {
		return fault("rate_limited", "Live session relay capacity is unavailable.")
	}
	return nil
}

func afterCommit(tx pgx.Tx, fn func()) {
	if rt, ok := tx.(*relayTx); ok {
		rt.committed = append(rt.committed, fn)
	}
}
