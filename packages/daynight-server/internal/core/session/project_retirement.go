package session

import (
	"context"
	"encoding/json"
	"fmt"
	"math"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RetireProject applies bounded, UUID-ordered retirement plans inside the caller's
// deletion transaction. The caller must already hold all project Task locks.
func RetireProject(ctx context.Context, dao store.ProjectSessionRetirementDAO, project string) error {
	after := ""
	for {
		facts, err := dao.LockProjectSessions(ctx, project, after, 128)
		if err != nil {
			return err
		}
		if len(facts) == 0 {
			return nil
		}
		plans := make([]store.ProjectSessionRetirementPlan, 0, len(facts))
		for _, fact := range facts {
			p := store.ProjectSessionRetirementPlan{ID: fact.ID, Backend: fact.Backend}
			switch fact.Backend {
			case "web":
				lifecycle := fact.Lifecycle
				if lifecycle != "archived" {
					lifecycle = "draining"
				}
				p.Receipts = []store.ProjectSessionReceiptTransition{{Previous: "accepted", Next: "rejected"}, {Previous: "offered", Next: "unknown"}, {Previous: "dispatching", Next: "unknown"}}
				p.SnapshotRemove = []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}
				p.SnapshotPatch = map[string]any{"lifecycle": lifecycle, "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}
			case "herdr":
				stale, unknown := "stale_fence", "input_unknown"
				p.Receipts = []store.ProjectSessionReceiptTransition{{Previous: "queued", Next: "rejected", ErrorCode: &stale}, {Previous: "dispatching", Next: "unknown", ErrorCode: &unknown}}
				var control *v2.ControlState
				if len(fact.Control) > 0 && string(fact.Control) != "null" {
					if err := json.Unmarshal(fact.Control, &control); err != nil {
						return fmt.Errorf("decode terminal control: %w", err)
					}
				}
				epoch := fact.ControlEpoch
				if control != nil {
					if number(epoch) == math.MaxInt64 {
						control.State = "closed"
					} else {
						epoch = next(epoch)
					}
					control.ControlEpoch = epoch
					r := terminalRecord{Control: control, ConnectionEpoch: control.ConnectionEpoch}
					suspendTerminalState(&r)
					control.UnavailableReason = nil
				}
				p.TerminalPatch = map[string]any{"Control": control, "ControlEpoch": epoch, "ControlActor": nil, "LastLeaseSeq": "0", "LastSeen": nil}
			default:
				return fmt.Errorf("unknown session backend %q", fact.Backend)
			}
			plans = append(plans, p)
			after = fact.ID
		}
		if err := dao.ApplyProjectSessionRetirement(ctx, plans); err != nil {
			return err
		}
	}
}

type projectLiveTicket struct {
	id    string
	cell  *liveCell
	value *liveSession
}
type projectContentTicket struct {
	id    string
	value *pendingContent
}
type projectFrameTicket struct {
	id    string
	value *terminalFrameWrite
}
type projectBodyTicket struct {
	session, id string
	value       *terminalBodyWrite
}

// ProjectRetirementTicket holds only objects already resident in this engine.
type ProjectRetirementTicket struct {
	engine  *Engine
	live    []projectLiveTicket
	content []projectContentTicket
	frames  []projectFrameTicket
	bodies  []projectBodyTicket
}

// CaptureProjectRetirement must run before commit while all Task locks remain held.
func (s *Engine) CaptureProjectRetirement(project string) *ProjectRetirementTicket {
	t := &ProjectRetirementTicket{engine: s}
	s.liveMutex.Lock()
	for id, cell := range s.live {
		cell.mu.Lock()
		value := cell.value
		if value != nil && value.Snapshot.Identity.ProjectID == project {
			t.live = append(t.live, projectLiveTicket{id, cell, value})
		}
		cell.mu.Unlock()
	}
	s.liveMutex.Unlock()
	s.content.mu.Lock()
	for id, p := range s.content.pending {
		if p.projectID == project {
			t.content = append(t.content, projectContentTicket{id, p})
		}
	}
	s.content.mu.Unlock()
	s.terminalMutex.Lock()
	for id, p := range s.terminalFrames {
		if p.projectID == project {
			t.frames = append(t.frames, projectFrameTicket{id, p})
		}
	}
	for id, p := range s.terminalFrameWrites {
		if p.projectID == project {
			t.frames = append(t.frames, projectFrameTicket{id, p})
		}
	}
	for id, entries := range s.terminalPending {
		for key, p := range entries {
			if p.projectID == project {
				t.bodies = append(t.bodies, projectBodyTicket{id, key, p})
			}
		}
	}
	s.terminalMutex.Unlock()
	return t
}

// Retire removes only captured objects and fences their delayed publishers. It
// must be called only after the deletion commit is confirmed.
func (t *ProjectRetirementTicket) Retire() {
	if t == nil || t.engine == nil {
		return
	}
	s := t.engine
	s.liveMutex.Lock()
	for _, item := range t.live {
		if s.live[item.id] == item.cell {
			item.cell.mu.Lock()
			if item.cell.value == item.value {
				delete(s.live, item.id)
			}
			item.cell.mu.Unlock()
		}
	}
	s.liveMutex.Unlock()
	s.content.mu.Lock()
	for _, item := range t.content {
		if s.content.pending[item.id] == item.value {
			delete(s.content.pending, item.id)
			select {
			case item.value.reply <- contentReply{err: fault("not_found", "Session is no longer available.")}:
			default:
			}
		}
	}
	s.content.mu.Unlock()
	s.terminalMutex.Lock()
	for _, item := range t.frames {
		if s.terminalFrames[item.id] == item.value {
			delete(s.terminalFrames, item.id)
		}
		if s.terminalFrameWrites[item.id] == item.value {
			delete(s.terminalFrameWrites, item.id)
		}
	}
	for _, item := range t.bodies {
		if s.terminalPending[item.session][item.id] == item.value {
			delete(s.terminalPending[item.session], item.id)
			if len(s.terminalPending[item.session]) == 0 {
				delete(s.terminalPending, item.session)
			}
		}
	}
	s.terminalMutex.Unlock()
}
