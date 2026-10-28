package sessionrelay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
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
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(value) > 512 || json.Unmarshal(raw, &p) != nil || p.Session != v.SessionID || p.Epoch != v.HistoryEpoch || p.Kind != kind || number(p.Position) < 0 || number(p.Upper) < 0 || decimal(number(p.Position)) != p.Position || decimal(number(p.Upper)) != p.Upper {
		return p, fault("reset_required", "Cursor does not belong to this session projection.")
	}
	return p, nil
}
func (s *Service) Current(ctx context.Context, p core.Principal, project, taskID string) (map[string]any, error) {
	var out map[string]any
	err := transact(ctx, s.DB, func(tx pgx.Tx) error {
		t, err := lockTask(ctx, tx, project, taskID)
		if err != nil {
			return err
		}
		admin, err := member(ctx, tx, p, project, s.now())
		if err != nil {
			return err
		}
		w := t.Properties.Worker
		if w == nil {
			out = map[string]any{"status": "not_applicable", "claimId": nil, "agentControlMode": nil}
			return nil
		}
		if w.AgentControlMode != core.AgentControlModeWeb {
			out = map[string]any{"status": "not_applicable", "claimId": w.ClaimID, "agentControlMode": "herdr"}
			return nil
		}
		var id string
		err = tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND claim_id=$3`, project, taskID, w.ClaimID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			out = map[string]any{"status": "not_registered", "claimId": w.ClaimID, "agentControlMode": "web"}
			return nil
		}
		if err != nil {
			return err
		}
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := s.archiveExpired(ctx, tx, r); err != nil {
			return err
		}
		out = map[string]any{"status": "registered", "session": permissions(r, admin || r.Owner == p.UserID, s.now())}
		return nil
	})
	return out, err
}
func (s *Service) Timeline(ctx context.Context, p core.Principal, project, taskID, id, direction, token string, limit int) (map[string]any, error) {
	var out map[string]any
	if limit < 1 || limit > 200 {
		return out, fault("invalid_input", "Timeline limit must be between 1 and 200.")
	}
	if direction != "tail" && direction != "before" && direction != "after" {
		return out, fault("invalid_input", "Unknown timeline direction.")
	}
	err := s.browser(ctx, p, project, taskID, id, func(tx pgx.Tx, r *record, _ task, _ bool) error {
		pos := position{Session: id, Epoch: r.Snapshot.HistoryEpoch, Kind: "timeline", Position: r.Snapshot.LastTimelineSeq, Upper: r.Snapshot.LastTimelineSeq}
		if direction != "tail" {
			var err error
			pos, err = decodeCursor(token, r.Snapshot, "timeline")
			if err != nil {
				return err
			}
			if number(pos.Upper) > number(r.Snapshot.LastTimelineSeq) || number(pos.Position) > number(pos.Upper) {
				return fault("reset_required", "Timeline cursor is beyond durable history.")
			}
		} else if token != "" {
			return fault("invalid_input", "Tail does not accept a cursor.")
		}
		condition := "entry_seq <= $2"
		order := "DESC"
		args := []any{id, number(pos.Upper), limit + 1}
		if direction == "before" {
			condition += " AND entry_seq < $4"
			args = append(args, number(pos.Position))
		}
		if direction == "after" {
			condition += " AND entry_seq > $4"
			args = append(args, number(pos.Position))
			order = "ASC"
		}
		rows, err := tx.Query(ctx, `SELECT entry FROM session_timeline WHERE session_id=$1 AND `+condition+` ORDER BY entry_seq `+order+` LIMIT $3`, args...)
		if err != nil {
			return err
		}
		items := []sp.TimelineEntry{}
		for rows.Next() {
			var raw []byte
			if err = rows.Scan(&raw); err != nil {
				rows.Close()
				return err
			}
			entry, e := sp.DecodeTimeline(raw)
			if e != nil {
				rows.Close()
				return e
			}
			items = append(items, entry)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		more := len(items) > limit
		if more {
			items = items[:limit]
		}
		if direction != "after" {
			slices.Reverse(items)
		}
		var before, after any
		var moreBefore, moreAfter bool
		if len(items) > 0 {
			first, last := items[0].EntrySeq, items[len(items)-1].EntrySeq
			pos.Position = first
			before = cursor(pos)
			pos.Position = last
			after = cursor(pos)
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_timeline WHERE session_id=$1 AND entry_seq<$2),EXISTS(SELECT 1 FROM session_timeline WHERE session_id=$1 AND entry_seq>$3 AND entry_seq<=$4)`, id, number(first), number(last), number(pos.Upper)).Scan(&moreBefore, &moreAfter); err != nil {
				return err
			}
		}
		_ = more
		resources := []sp.Resource{}
		seen := map[string]bool{}
		for _, entry := range items {
			for _, ref := range resourceIDs(entry) {
				if seen[ref] {
					continue
				}
				seen[ref] = true
				var raw []byte
				err = tx.QueryRow(ctx, `SELECT descriptor FROM session_resources WHERE session_id=$1 AND resource_id=$2`, id, ref).Scan(&raw)
				if errors.Is(err, pgx.ErrNoRows) {
					continue
				}
				if err != nil {
					return err
				}
				resource, err := sp.DecodeResource(raw)
				if err != nil {
					return err
				}
				resources = append(resources, resource)
			}
		}
		out = map[string]any{"sessionId": id, "historyEpoch": r.Snapshot.HistoryEpoch, "items": items, "resources": resources, "beforeCursor": before, "afterCursor": after, "hasMoreBefore": moreBefore, "hasMoreAfter": moreAfter, "lastEventSeq": r.Snapshot.LastEventSeq}
		return nil
	})
	return out, err
}
func resourceIDs(entry sp.TimelineEntry) []string {
	out := []string{}
	for _, key := range []string{"content", "output"} {
		var parts []struct {
			Type       string `json:"type"`
			ResourceID string `json:"resourceId"`
		}
		_ = json.Unmarshal(entry.Data[key], &parts)
		for _, part := range parts {
			if part.Type == "resource" {
				out = append(out, part.ResourceID)
			}
		}
	}
	return out
}
func (s *Service) BrowserPoll(ctx context.Context, p core.Principal, project, taskID, id, token string) (sp.Snapshot, []map[string]any, string, error) {
	var snapshot sp.Snapshot
	events := []map[string]any{}
	resultCursor := token
	err := s.browser(ctx, p, project, taskID, id, func(tx pgx.Tx, r *record, t task, write bool) error {
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
		rows, err := tx.Query(ctx, `SELECT event FROM session_events WHERE session_id=$1 AND event_seq>$2 AND event_seq<=$3 ORDER BY event_seq LIMIT 100`, id, number(pos.Position), number(snapshot.LastEventSeq))
		if err != nil {
			return err
		}
		defer rows.Close()
		total := 0
		for rows.Next() {
			var raw []byte
			if err = rows.Scan(&raw); err != nil {
				return err
			}
			if len(events) > 0 && total+len(raw) > sp.MaxFrameBytes {
				break
			}
			total += len(raw)
			var event map[string]any
			if err = json.Unmarshal(raw, &event); err != nil {
				return err
			}
			if event["kind"] == "snapshot" {
				var historical sp.Snapshot
				if err = json.Unmarshal(encode(event["payload"]), &historical); err != nil {
					return err
				}
				copy := *r
				copy.Snapshot = historical
				event["payload"] = permissions(&copy, write && (active(t, r) || current(t, r) && r.Snapshot.Lifecycle == "draining"), s.now())
			}
			seq, _ := event["eventSeq"].(string)
			resultCursor = EventCursor(snapshot, seq)
			events = append(events, event)
		}
		return rows.Err()
	})
	return snapshot, events, resultCursor, err
}
