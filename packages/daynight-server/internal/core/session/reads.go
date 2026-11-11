package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type position struct {
	Session  string `json:"s"`
	Epoch    string `json:"e"`
	Kind     string `json:"k"`
	Position string `json:"p"`
	Upper    string `json:"u"`
}

func cursor(p position) string { return base64.RawURLEncoding.EncodeToString(encode(p)) }
func EventCursor(v sp.Snapshot, seq string) string {
	return cursor(position{Session: v.SessionID, Epoch: v.HistoryEpoch, Kind: "event", Position: seq, Upper: "0"})
}
func decodeCursor(value string, v sp.Snapshot, kind string) (position, error) {
	var p position
	if len(value) > 512 {
		return p, fault("reset_required", "Cursor does not belong to this session projection.")
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || json.Unmarshal(raw, &p) != nil || p.Session != v.SessionID || p.Epoch != v.HistoryEpoch || p.Kind != kind || number(p.Position) < 0 || number(p.Upper) < 0 || decimal(number(p.Position)) != p.Position || decimal(number(p.Upper)) != p.Upper {
		return p, fault("reset_required", "Cursor does not belong to this session projection.")
	}
	return p, nil
}
func (s *Execution) Current(ctx context.Context, p model.Principal, project, taskID string) (map[string]any, error) {
	return s.current(ctx, p, project, taskID, false)
}

func (s *Execution) CurrentWithStartup(ctx context.Context, p model.Principal, project, taskID string) (map[string]any, error) {
	return s.current(ctx, p, project, taskID, true)
}

func (s *Execution) current(ctx context.Context, p model.Principal, project, taskID string, includeStartup bool) (map[string]any, error) {
	var out map[string]any
	err := s.taskRun(ctx, p, project, taskID, func(op *Operation, scope store.SessionScope, task *TaskAccess, load func(string) (*Access, error)) error {
		_, tx := op.scoped(scope)
		t := task.task
		w := t.Worker
		if t.Type == model.TaskTypeGoal || w == nil {
			out = map[string]any{"status": "not_applicable", "claimId": nil, "agentControlMode": nil}
			return nil
		}
		if w.AgentControlMode != model.AgentControlModeWeb {
			out = map[string]any{"status": "not_applicable", "claimId": w.ClaimID, "agentControlMode": "herdr"}
			return nil
		}
		id, err := tx.dao.CurrentTaskSession(ctx, project, taskID, w.ClaimID)
		if errors.Is(err, model.ErrNotFound) {
			out = map[string]any{"status": "not_registered", "claimId": w.ClaimID, "agentControlMode": "web"}
			return nil
		}
		if err != nil {
			return err
		}
		access, err := load(id)
		if err != nil {
			return err
		}
		r := access.record
		if err := s.archiveExpired(ctx, tx, r); err != nil {
			return err
		}
		out = map[string]any{"status": "registered", "session": permissions(r, r.Owner == p.UserID && active(t, r), s.now())}
		if includeStartup {
			out["startupReport"] = nil
			report := t.StartupReport
			if report != nil && report.SessionID == r.Snapshot.SessionID && report.ClaimID == r.Snapshot.ClaimID && report.ExecutionGeneration == r.Snapshot.ExecutionGeneration && report.ControllerInstanceID == r.Snapshot.Identity.ControllerInstanceID {
				out["startupReport"] = report
			}
		}
		return nil
	})
	return out, err
}
func (s *Execution) Timeline(ctx context.Context, p model.Principal, project, taskID, id, direction, token string, limit int) (map[string]any, error) {
	if limit < 1 || limit > 200 {
		return nil, fault("invalid_input", "Timeline limit must be between 1 and 200.")
	}
	if direction != "tail" && direction != "before" && direction != "after" {
		return nil, fault("invalid_input", "Unknown timeline direction.")
	}
	if len(token) > 512 || direction == "tail" && token != "" || direction != "tail" && token == "" {
		return nil, fault("invalid_input", "Timeline cursor does not match the requested direction.")
	}
	var cursorValue any
	if token != "" {
		cursorValue = token
	}
	reply, err := s.localContent(ctx, p, project, taskID, id, map[string]any{"kind": "timeline", "direction": direction, "cursor": cursorValue, "limit": limit})
	if err != nil {
		return nil, err
	}
	page := reply.result
	if page.HistoryEpoch != reply.snapshot.HistoryEpoch || len(page.Items) > limit {
		return nil, fault("reset_required", "The controller returned a page from another history boundary.")
	}
	return map[string]any{"sessionId": id, "historyEpoch": page.HistoryEpoch, "items": page.Items, "resources": page.Resources, "beforeCursor": contentCursor(page.BeforeCursor), "afterCursor": contentCursor(page.AfterCursor), "hasMoreBefore": page.HasMoreBefore, "hasMoreAfter": page.HasMoreAfter, "lastEventSeq": reply.snapshot.LastEventSeq}, nil
}
func contentCursor(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}
func (s *Execution) BrowserPoll(ctx context.Context, p model.Principal, project, taskID, id, token string) (sp.Snapshot, []map[string]any, string, error) {
	var snapshot sp.Snapshot
	events := []map[string]any{}
	resultCursor := token
	err := s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, t task, write bool) error {
		snapshot = permissions(r, write && (active(t, r) || current(t, r) && r.Snapshot.Lifecycle == "draining"), s.now())
		if token == "" {
			resultCursor = EventCursor(snapshot, snapshot.LastEventSeq)
			return nil
		}
		pos, err := decodeCursor(token, snapshot, "event")
		if err != nil {
			return err
		}
		if number(pos.Position) > number(snapshot.LastEventSeq) {
			return fault("reset_required", "Event cursor is beyond durable history.")
		}

		if r.Live == nil || !r.Live.Synced {
			return fault("controller_offline", "Connect the original controller to observe this session.")
		}
		if number(pos.Position) < r.Live.MinEventSeq {
			return fault("reset_required", "The live event window no longer includes this cursor.")
		}
		total := 0
		for _, raw := range r.Live.Events {
			var event map[string]any
			if err = json.Unmarshal(raw, &event); err != nil {
				return err
			}
			seq, _ := event["eventSeq"].(string)
			if number(seq) <= number(pos.Position) || number(seq) > number(snapshot.LastEventSeq) {
				continue
			}
			if len(events) >= 100 || len(events) > 0 && total+len(raw) > sp.MaxFrameBytes {
				break
			}
			total += len(raw)
			if event["kind"] == "snapshot" {
				var historical sp.Snapshot
				if err = json.Unmarshal(encode(event["payload"]), &historical); err != nil {
					return err
				}
				copy := *r
				copy.Snapshot = historical
				event["payload"] = permissions(&copy, write && (active(t, r) || current(t, r) && r.Snapshot.Lifecycle == "draining"), s.now())
			}
			resultCursor = EventCursor(snapshot, seq)
			events = append(events, event)
		}
		return nil
	})
	return snapshot, events, resultCursor, err
}
