package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type BotHistoryWindowRequest struct {
	Mode, Cursor            string
	Limit, ResponseOverhead int
}

// BotHistoryWindowResetError preserves the authorized current boundary when a
// reader must discard its old continuation and fetch the recent page again.
type BotHistoryWindowResetError struct{ Boundary sp.BotHistoryWindowBoundary }

func (e *BotHistoryWindowResetError) Error() string {
	return "The Bot history window changed; restart from the recent page."
}
func (e *BotHistoryWindowResetError) Unwrap() error { return fault("reset_required", e.Error()) }

func botWindowReset(boundary sp.BotHistoryWindowBoundary) error {
	return &BotHistoryWindowResetError{Boundary: boundary}
}

func botWindowContentCapability(r *record, kind string) error {
	window := r.Live != nil && r.Live.BotHistoryWindowVersion == sp.BotHistoryWindowVersion
	if kind == "bot_history_window" {
		if r.BotID == nil || !window {
			return fault("upgrade_required", "Reconnect a compatible Bot controller to read its history window.")
		}
	} else if window && (kind == "timeline" || kind == "inspect_page" || kind == "entry_chunk") {
		return fault("upgrade_required", "This Bot retains a history window; use the versioned window reader.")
	}
	return nil
}

type botWindowPosition struct {
	Boundary       sp.BotHistoryWindowBoundary
	Mode, Sequence string
}

func botWindowCursor(boundary sp.BotHistoryWindowBoundary, mode, sequence string) string {
	through := "0"
	if boundary.ThroughSeq != nil {
		through = *boundary.ThroughSeq
	}
	data, _ := json.Marshal([]string{"bot_history_window", boundary.SessionID, boundary.TestExecutionID, boundary.ExecutionGeneration, boundary.ConnectionEpoch, boundary.HistoryEpoch, boundary.WindowRevision, mode, sequence, through})
	return base64.RawURLEncoding.EncodeToString(data)
}

func parseBotWindowCursor(token string, boundary sp.BotHistoryWindowBoundary, mode string) (botWindowPosition, error) {
	var values []string
	raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if len(token) > sp.MaxHistoryCursorBytes || err != nil || json.Unmarshal(raw, &values) != nil || len(values) != 10 {
		return botWindowPosition{}, botWindowReset(boundary)
	}
	if values[0] != "bot_history_window" || values[1] != boundary.SessionID || values[2] != boundary.TestExecutionID || values[3] != boundary.ExecutionGeneration || values[4] != boundary.ConnectionEpoch || values[5] != boundary.HistoryEpoch || values[7] != mode {
		return botWindowPosition{}, botWindowReset(boundary)
	}
	for i, value := range []string{values[6], values[8], values[9]} {
		if number(value) < 0 || decimal(number(value)) != value || i == 0 && value == "0" {
			return botWindowPosition{}, botWindowReset(boundary)
		}
	}
	if number(values[6]) > number(boundary.WindowRevision) || number(values[8]) > number(values[9]) || mode == "before" && values[8] == "0" {
		return botWindowPosition{}, botWindowReset(boundary)
	}
	previous := boundary
	previous.WindowRevision = values[6]
	previous.ThroughSeq = nil
	if values[9] != "0" {
		through := values[9]
		previous.ThroughSeq = &through
	}
	position := botWindowPosition{Boundary: previous, Mode: mode, Sequence: values[8]}
	if boundary.ThroughSeq == nil && values[9] != "0" || boundary.ThroughSeq != nil && number(values[9]) > number(*boundary.ThroughSeq) {
		return botWindowPosition{}, botWindowReset(boundary)
	}
	if mode == "before" {
		if boundary.RetainedFromSeq == nil || number(values[8]) <= number(*boundary.RetainedFromSeq) && boundary.EarlierHistoryUnavailable {
			return botWindowPosition{}, botWindowReset(boundary)
		}
	} else if values[6] != boundary.WindowRevision {
		// A changed revision restarts a bounded scan so updates to existing IDs
		// are included. A partially read scan cannot span two revisions.
		if values[8] != "0" || boundary.RetainedFromSeq == nil || boundary.EarlierHistoryUnavailable && number(values[9]) < number(*boundary.RetainedFromSeq) {
			return botWindowPosition{}, botWindowReset(boundary)
		}
	}
	return position, nil
}

func (s *Execution) ReadBotHistoryWindow(ctx context.Context, principal model.Principal, project, taskID, id string, in BotHistoryWindowRequest) (sp.BotHistoryWindowPage, error) {
	if in.Mode == "" {
		in.Mode = "tail"
	}
	if in.Limit == 0 {
		in.Limit = 50
	}
	if in.Mode != "tail" && in.Mode != "before" && in.Mode != "changes" || (in.Mode == "tail") != (in.Cursor == "") || in.Limit < 1 || in.Limit > 200 || in.ResponseOverhead < 0 || in.ResponseOverhead >= sp.MaxHistoryResponseBytes || len(in.Cursor) > sp.MaxHistoryCursorBytes {
		return sp.BotHistoryWindowPage{}, fault("invalid_input", "Invalid Bot history window request.")
	}
	var initial sp.BotHistoryCheckpoint
	var position botWindowPosition
	err := s.browser(ctx, principal, project, taskID, id, func(tx *operationTx, r *record, _ task, _ bool) error {
		if err := onlineContent(r, s.now()); err != nil {
			return err
		}
		if err := botWindowContentCapability(r, "bot_history_window"); err != nil {
			return err
		}
		var err error
		initial, err = readBotHistoryCheckpoint(ctx, tx, r)
		if err != nil {
			return err
		}
		if in.Cursor != "" {
			position, err = parseBotWindowCursor(in.Cursor, initial.BotHistoryWindowBoundary, in.Mode)
		}
		return err
	})
	if err != nil {
		return sp.BotHistoryWindowPage{}, err
	}
	var token any
	if in.Cursor != "" {
		token = in.Cursor
	}
	// The public reader owns both continuation tokens. Reserve their maximum
	// encoded growth over null fields before the Controller selects its page.
	boundary := initial.BotHistoryWindowBoundary
	boundary.WindowRevision = "9223372036854775807"
	through := "9223372036854775807"
	boundary.ThroughSeq = &through
	cursorOverhead := len(botWindowCursor(boundary, "before", through)) + len(botWindowCursor(boundary, "changes", through))
	overhead := min(in.ResponseOverhead+cursorOverhead, sp.MaxHistoryResponseBytes-1)
	reply, readErr := s.localContent(ctx, principal, project, taskID, id, map[string]any{"kind": "bot_history_window", "historyEpoch": initial.HistoryEpoch, "mode": in.Mode, "cursor": token, "limit": in.Limit, "responseOverhead": overhead})
	// Recheck the committed window after the network wait. The reply never
	// publishes a checkpoint or changes resource ownership on a browser read.
	var page sp.BotHistoryWindowPage
	err = s.browser(ctx, principal, project, taskID, id, func(tx *operationTx, r *record, _ task, _ bool) error {
		if err := onlineContent(r, s.now()); err != nil {
			return err
		}
		if err := botWindowContentCapability(r, "bot_history_window"); err != nil {
			return err
		}
		current, err := readBotHistoryCheckpoint(ctx, tx, r)
		if err != nil {
			return err
		}
		if current.ControllerFence != initial.ControllerFence || current.HistoryEpoch != initial.HistoryEpoch {
			return botWindowReset(current.BotHistoryWindowBoundary)
		}
		if readErr != nil {
			var f *model.Fault
			if errors.As(readErr, &f) && f.Code == "reset_required" {
				return botWindowReset(current.BotHistoryWindowBoundary)
			}
			return readErr
		}
		if reply.result == nil || reply.result.BotHistoryWindow == nil {
			return fault("content_unavailable", "The controller omitted its Bot history window.")
		}
		page = *reply.result.BotHistoryWindow
		if in.Cursor != "" {
			position, err = parseBotWindowCursor(in.Cursor, current.BotHistoryWindowBoundary, in.Mode)
			if err != nil {
				return err
			}
		}
		if err := validateBotHistoryWindowPage(current, page, in, position); err != nil {
			return err
		}
		setBotWindowCursors(&page, current, in, position)
		raw, err := sp.MarshalWire(page)
		if err != nil || len(raw)+in.ResponseOverhead > sp.MaxHistoryResponseBytes {
			return fault("content_unavailable", "The Bot history window exceeds its response budget.")
		}
		return nil
	})
	if err != nil {
		return sp.BotHistoryWindowPage{}, err
	}
	return page, nil
}

func botWindowCandidates(checkpoint sp.BotHistoryCheckpoint, in BotHistoryWindowRequest, position botWindowPosition) []sp.BotHistoryCheckpointEntry {
	entries := checkpoint.Entries
	if in.Mode == "tail" {
		return entries
	}
	if in.Mode == "before" {
		end := 0
		for end < len(entries) && number(entries[end].EntrySeq) < number(position.Sequence) {
			end++
		}
		return entries[:end]
	}
	if position.Boundary.WindowRevision != checkpoint.WindowRevision {
		return entries
	}
	if position.Sequence == "0" {
		return nil
	}
	start := 0
	for start < len(entries) && number(entries[start].EntrySeq) <= number(position.Sequence) {
		start++
	}
	return entries[start:]
}

func validateBotHistoryWindowPage(checkpoint sp.BotHistoryCheckpoint, page sp.BotHistoryWindowPage, in BotHistoryWindowRequest, position botWindowPosition) error {
	if !jsonEqual(encode(checkpoint.BotHistoryWindowBoundary), encode(page.BotHistoryWindowBoundary)) {
		return botWindowReset(checkpoint.BotHistoryWindowBoundary)
	}
	raw, err := sp.MarshalWire(page)
	if err != nil {
		return fault("content_unavailable", "The controller returned an invalid Bot history window.")
	}
	if _, err := sp.DecodeBotHistoryWindowPage(raw); err != nil {
		return fault("content_unavailable", "The controller returned an invalid Bot history window.")
	}
	candidates := botWindowCandidates(checkpoint, in, position)
	if len(page.Items) > in.Limit || len(page.Items) > len(candidates) || len(page.Items) == 0 && len(candidates) != 0 {
		return fault("content_unavailable", "The controller omitted retained Bot history entries.")
	}
	start := 0
	if in.Mode != "changes" {
		start = len(candidates) - len(page.Items)
	}
	for index, entry := range page.Items {
		retained := candidates[start+index]
		digest, err := sp.BotHistoryWindowEntryDigest(entry)
		if err != nil || entry.EntryID != retained.EntryID || entry.EntrySeq != retained.EntrySeq || entry.Revision != retained.Revision || digest != retained.SHA256 || !slices.Equal(entry.ResourceIDs, retained.ResourceIDs) {
			return fault("content_changed", "The Bot history entry differs from its committed revision.")
		}
	}
	return nil
}

func setBotWindowCursors(page *sp.BotHistoryWindowPage, checkpoint sp.BotHistoryCheckpoint, in BotHistoryWindowRequest, position botWindowPosition) {
	page.BeforeCursor = nil
	page.HasEarlierHistory = false
	if len(page.Items) > 0 && len(checkpoint.Entries) > 0 && page.Items[0].EntrySeq != checkpoint.Entries[0].EntrySeq {
		token := botWindowCursor(page.BotHistoryWindowBoundary, "before", page.Items[0].EntrySeq)
		page.BeforeCursor, page.HasEarlierHistory = &token, true
	}
	sequence := "0"
	if in.Mode == "changes" && len(page.Items) < len(botWindowCandidates(checkpoint, in, position)) && len(page.Items) > 0 {
		sequence = page.Items[len(page.Items)-1].EntrySeq
	}
	token := botWindowCursor(page.BotHistoryWindowBoundary, "changes", sequence)
	page.NextCursor = &token
}
