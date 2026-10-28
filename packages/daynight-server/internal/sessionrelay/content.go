package sessionrelay

import (
	"context"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const contentDeadline = 15 * time.Second
const maxContentRequests = 32
const maxSessionContentRequests = 4

type contentReply struct {
	result   *sp.ContentResult
	snapshot sp.Snapshot
	err      error
}
type pendingContent struct {
	fence   sp.ControllerFence
	epoch   string
	request map[string]any
	kind    string
	sent    bool
	reply   chan contentReply
}
type contentBroker struct {
	mu      sync.Mutex
	pending map[string]*pendingContent
}

func onlineContent(r *record, now time.Time) error {
	if r.Live == nil || !r.Live.Synced || r.Snapshot.Lifecycle == "archived" || !r.Snapshot.Synchronized || r.Snapshot.ConnectionState != "connected" || r.LastSeen == nil || now.Sub(*r.LastSeen) > HeartbeatTimeout || r.ConnectionExpiry == nil || !now.Before(*r.ConnectionExpiry) {
		return fault("controller_offline", "Connect the original controller to read its local session content.")
	}
	return nil
}
func (b *contentBroker) add(p *pendingContent) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending == nil {
		b.pending = map[string]*pendingContent{}
	}
	n := 0
	for _, current := range b.pending {
		if current.fence.SessionID == p.fence.SessionID {
			n++
		}
	}
	if len(b.pending) >= maxContentRequests || n >= maxSessionContentRequests {
		return "", fault("rate_limited", "Session content request capacity is unavailable.")
	}
	id := uuid.NewString()
	p.request["requestId"] = id
	b.pending[id] = p
	return id, nil
}
func (b *contentBroker) remove(id string) { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }
func (s *Service) contentRequests(tx pgx.Tx, r *record) []map[string]any {
	out := []map[string]any{}
	if onlineContent(r, s.now()) != nil {
		return out
	}
	s.content.mu.Lock()
	defer s.content.mu.Unlock()
	for id, p := range s.content.pending {
		if p.fence != r.Snapshot.ControllerFence || p.epoch != r.Snapshot.HistoryEpoch || p.sent {
			continue
		}
		out = append(out, p.request)
		afterCommit(tx, func() {
			s.content.mu.Lock()
			defer s.content.mu.Unlock()
			if s.content.pending[id] == p {
				p.sent = true
			}
		})
	}
	return out
}
func (s *Service) acceptContent(tx pgx.Tx, r *record, m sp.ControllerMessage) (map[string]any, error) {
	s.content.mu.Lock()
	p := s.content.pending[m.RequestID]
	s.content.mu.Unlock()
	// A canceled HTTP request or a retired connection must not close a healthy
	// controller channel when its read response arrives late.
	if p == nil || p.fence != m.ControllerFence || p.epoch != r.Snapshot.HistoryEpoch {
		return nil, nil
	}
	reply := contentReply{result: m.ContentResult, snapshot: r.Snapshot}
	if err := onlineContent(r, s.now()); err != nil {
		reply.err = err
	} else if m.ContentError != nil {
		code := m.ContentError.Code
		switch code {
		case "not_found", "reset_required", "payload_too_large", "content_unavailable", "resource_conflict", "rate_limited":
		default:
			code = "content_unavailable"
		}
		reply.err = fault(code, "The controller could not provide the requested local session content.")
	} else if number(m.SourceThrough) != r.SourceSeq {
		reply.err = fault("reset_required", "Local content does not match the observed source boundary.")
	} else if m.ContentResult == nil || m.ContentResult.Kind != p.kind {
		reply.err = fault("content_unavailable", "The controller returned an incompatible content result.")
	}
	// Capture the event cursor in the same ordered message transaction as the
	// source barrier. A later snapshot could skip events emitted after this page.
	afterCommit(tx, func() {
		s.content.mu.Lock()
		current := s.content.pending[m.RequestID]
		s.content.mu.Unlock()
		if current == p {
			select {
			case p.reply <- reply:
			default:
			}
		}
	})
	return nil, nil
}
func (s *Service) localContent(ctx context.Context, p core.Principal, project, taskID, id string, fields map[string]any) (contentReply, error) {
	var pending *pendingContent
	err := s.browser(ctx, p, project, taskID, id, func(_ pgx.Tx, r *record, _ task, _ bool) error {
		if err := onlineContent(r, s.now()); err != nil {
			return err
		}
		msg := envelope(r, "content_request")
		for k, v := range fields {
			msg[k] = v
		}
		if fields["kind"] == "timeline" {
			msg["historyEpoch"] = r.Snapshot.HistoryEpoch
		}
		pending = &pendingContent{fence: r.Snapshot.ControllerFence, epoch: r.Snapshot.HistoryEpoch, request: msg, kind: fields["kind"].(string), reply: make(chan contentReply, 1)}
		return nil
	})
	if err != nil {
		return contentReply{}, err
	}
	requestID, err := s.content.add(pending)
	if err != nil {
		return contentReply{}, err
	}
	defer s.content.remove(requestID)
	timer := time.NewTimer(contentDeadline)
	defer timer.Stop()
	var reply contentReply
	select {
	case reply = <-pending.reply:
	case <-ctx.Done():
		return contentReply{}, ctx.Err()
	case <-timer.C:
		return contentReply{}, fault("controller_offline", "The online controller did not return its local content before the request deadline.")
	}
	// Authorization is checked again after the untrusted network wait. Do not
	// return a page to an owner or member whose permission was revoked meanwhile.
	err = s.browser(ctx, p, project, taskID, id, func(_ pgx.Tx, r *record, _ task, _ bool) error {
		if e := onlineContent(r, s.now()); e != nil {
			return e
		}
		if r.Snapshot.ControllerFence != pending.fence || r.Snapshot.HistoryEpoch != pending.epoch {
			return fault("reset_required", "The controller connection changed during the content read.")
		}
		return nil
	})
	if err != nil {
		return contentReply{}, err
	}
	if reply.err != nil {
		return contentReply{}, reply.err
	}
	return reply, nil
}
