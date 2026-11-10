package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func (s *Execution) ReadLivePage(ctx context.Context, p model.Principal, project, task, id string, in LiveHistoryRequest) (sp.MessagePage, error) {
	empty := sp.MessagePage{SessionID: id, HistoryEpoch: in.Epoch, Source: "live", Items: []sp.MessageItem{}, Coverage: sp.HistoryCoverage{State: "complete"}, ObservedAt: s.now().UTC()}
	if in.Limit < 1 || in.Limit > 200 || in.ResponseOverhead < 0 || in.ResponseOverhead >= sp.MaxHistoryResponseBytes {
		return empty, fault("invalid_input", "Invalid history page limit or response budget.")
	}
	var position HistoryPosition
	if in.Before != "" {
		var err error
		position, err = ParseHistoryPosition(in.Before, false)
		if err != nil {
			return empty, err
		}
		if !position.Matches(id, in.Epoch, "live", in.Epoch) {
			return empty, fault("reset_required", "The history source changed; restart from the latest page.")
		}
	}
	reader, err := s.taskReader()
	if err != nil {
		return empty, err
	}
	if in.ContentReadVersion == 0 {
		return reader.readLegacyPage(ctx, p, project, task, id, in, position)
	}
	// The controller fits its own result plus the exact public shape difference.
	// A maximum-precision timestamp prevents a later sample from growing the page.
	if empty.HistoryEpoch == "" {
		empty.HistoryEpoch = "00000000-0000-4000-8000-000000000000"
	}
	empty.ObservedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	final, _ := json.Marshal(empty)
	wire, _ := sp.MarshalWire(sp.ContentResult{Kind: "inspect_page", HistoryEpoch: empty.HistoryEpoch, MessageItems: []sp.MessageItem{}})
	overhead := in.ResponseOverhead + len(final) - len(wire)
	if overhead < 0 {
		overhead = 0
	}
	var token any
	if in.Before != "" {
		token = in.Before
	}
	reply, err := reader.localContent(ctx, p, project, task, id, map[string]any{"kind": "inspect_page", "historyEpoch": in.Epoch, "cursor": token, "limit": in.Limit, "responseOverhead": overhead})
	if err != nil {
		return empty, err
	}
	result := reply.result
	if in.Epoch != "" && result.HistoryEpoch != in.Epoch || result.HistoryEpoch != reply.snapshot.HistoryEpoch || len(result.MessageItems) > in.Limit {
		return empty, fault("reset_required", "The controller returned a different history boundary.")
	}
	in.Epoch = result.HistoryEpoch
	out := sp.MessagePage{SessionID: id, HistoryEpoch: in.Epoch, Source: "live", Items: result.MessageItems, BeforeCursor: result.BeforeCursor, HasMoreBefore: result.HasMoreBefore, Coverage: sp.HistoryCoverage{State: "complete"}, ObservedAt: s.now().UTC()}
	if err = validateLiveHistoryPage(out, in); err != nil {
		return empty, err
	}
	if !historyPageFits(out, in.ResponseOverhead) {
		return empty, fault("content_unavailable", "The controller exceeded the history response budget.")
	}
	return out, nil
}
func validateLiveHistoryPage(page sp.MessagePage, in LiveHistoryRequest) error {
	if page.HasMoreBefore && page.BeforeCursor == nil || page.BeforeCursor != nil && len(page.Items) == 0 {
		return fault("content_unavailable", "The controller returned an unusable history continuation.")
	}
	if page.BeforeCursor != nil {
		position, err := ParseHistoryPosition(*page.BeforeCursor, false)
		if err != nil {
			return err
		}
		if !position.Matches(page.SessionID, page.HistoryEpoch, "live", page.HistoryEpoch) || position.Sequence != page.Items[0].EntrySeq {
			return fault("reset_required", "The controller returned a different history cursor.")
		}
	}
	for _, item := range page.Items {
		if in.Before != "" {
			pos, _ := ParseHistoryPosition(in.Before, false)
			if number(item.EntrySeq) >= number(pos.Sequence) {
				return fault("reset_required", "The controller returned entries beyond the history cursor.")
			}
		}
		if item.ContentRef != nil {
			pos, err := ParseHistoryPosition(item.ContentRef.Cursor, true)
			if err != nil {
				return err
			}
			if !pos.Matches(page.SessionID, page.HistoryEpoch, "live", page.HistoryEpoch) || pos.EntryID != item.EntryID || pos.Revision != item.Revision || pos.SHA256 != item.ContentRef.SHA256 || pos.ByteLength != item.ContentRef.ByteLength || pos.Offset != "0" {
				return fault("content_unavailable", "The controller returned an inconsistent entry reference.")
			}
		}
	}
	return nil
}
func (s *Execution) readLegacyPage(ctx context.Context, p model.Principal, project, task, id string, in LiveHistoryRequest, position HistoryPosition) (sp.MessagePage, error) {
	var token any
	direction := "tail"
	if in.Before != "" {
		raw, _ := json.Marshal([]string{id, in.Epoch, position.Sequence})
		token = base64.RawURLEncoding.EncodeToString(raw)
		direction = "before"
	}
	reply, err := s.localContent(ctx, p, project, task, id, map[string]any{"kind": "timeline", "direction": direction, "cursor": token, "limit": in.Limit})
	if err != nil {
		return sp.MessagePage{}, err
	}
	if in.Epoch != "" && reply.result.HistoryEpoch != in.Epoch || reply.result.HistoryEpoch != reply.snapshot.HistoryEpoch || len(reply.result.Items) > in.Limit {
		return sp.MessagePage{}, fault("reset_required", "The history epoch changed.")
	}
	in.Epoch = reply.result.HistoryEpoch
	entries := reply.result.Items
	originalCount := len(entries)
	for {
		out, e := BuildHistoryPage(id, in.Epoch, "live", in.Epoch, entries, reply.result.Resources, "", in.Limit, false, in.ResponseOverhead, s.now())
		if e != nil {
			return out, e
		}
		truncated := false
		for _, item := range out.Items {
			truncated = truncated || item.Truncated
		}
		if truncated {
			if len(entries) <= 1 {
				return out, fault("upgrade_required", "Reconnect an upgraded controller to read this complete entry.")
			}
			entries = entries[1:]
			continue
		}
		out.HasMoreBefore = out.HasMoreBefore || reply.result.HasMoreBefore || len(entries) < originalCount
		if out.HasMoreBefore && len(out.Items) > 0 {
			cursor := HistoryPosition{Source: "live", SessionID: id, Epoch: in.Epoch, Version: in.Epoch, Sequence: out.Items[0].EntrySeq}.Cursor()
			out.BeforeCursor = &cursor
		}
		if e = validateLiveHistoryPage(out, in); e != nil {
			return out, e
		}
		if !historyPageFits(out, in.ResponseOverhead) {
			return out, fault("content_unavailable", "The history response exceeded its budget.")
		}
		return out, nil
	}
}
func (s *Execution) ReadLiveEntry(ctx context.Context, p model.Principal, project, task, id, epoch, token string) (sp.EntryChunk, error) {
	empty := sp.EntryChunk{}
	position, err := ParseHistoryPosition(token, true)
	if err != nil {
		return empty, err
	}
	if !position.Matches(id, epoch, "live", epoch) {
		return empty, fault("reset_required", "The history source changed; restart from the latest page.")
	}
	reader, err := s.taskReader()
	if err != nil {
		return empty, err
	}
	reply, err := reader.localContent(ctx, p, project, task, id, map[string]any{"kind": "entry_chunk", "historyEpoch": epoch, "cursor": token, "limit": sp.MaxEntryChunkBytes})
	if err != nil {
		return empty, err
	}
	v := reply.result
	if v.HistoryEpoch != epoch || reply.snapshot.HistoryEpoch != epoch {
		return empty, fault("reset_required", "The history epoch changed.")
	}
	if v.EntryID != position.EntryID || v.Revision != position.Revision || v.SHA256 != position.SHA256 || v.ByteLength != position.ByteLength || v.Offset != position.Offset {
		return empty, fault("content_changed", "The entry content changed.")
	}
	nextOffset := number(v.Offset) + int64(len(v.Fragment))
	if len(v.Fragment) > sp.MaxEntryChunkBytes || nextOffset > number(v.ByteLength) || v.EOF != (nextOffset == number(v.ByteLength)) || v.EOF != (v.NextCursor == nil) {
		return empty, fault("content_unavailable", "The controller returned an invalid entry chunk.")
	}
	if v.NextCursor != nil {
		next, e := ParseHistoryPosition(*v.NextCursor, true)
		if e != nil {
			return empty, e
		}
		expected := position
		expected.Offset = decimal(nextOffset)
		if next != expected || nextOffset == number(v.Offset) {
			return empty, fault("content_unavailable", "The controller returned an invalid entry continuation.")
		}
	}
	return sp.EntryChunk{SessionID: id, HistoryEpoch: epoch, Source: "live", EntryID: v.EntryID, Revision: v.Revision, SHA256: v.SHA256, ByteLength: v.ByteLength, Offset: v.Offset, Fragment: v.Fragment, NextCursor: v.NextCursor, EOF: v.EOF, ObservedAt: s.now().UTC()}, nil
}
