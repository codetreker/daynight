package session

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
	"time"
	"unicode/utf8"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

// HistoryPosition binds every continuation to an immutable source domain.
// A cursor is a position, never an authorization token.
type HistoryPosition struct {
	Source, SessionID, Epoch, Version, Sequence, EntryID, Revision, SHA256, ByteLength, Offset string
	Chunk                                                                                      bool
}

func (p HistoryPosition) Cursor() string {
	var value []any
	if p.Chunk {
		value = []any{1, p.Source, p.SessionID, p.Epoch, p.Version, p.EntryID, p.Revision, p.SHA256, p.ByteLength, p.Offset}
	} else {
		value = []any{1, p.Source, p.SessionID, p.Epoch, p.Version, p.Sequence}
	}
	raw, _ := json.Marshal(value)
	return base64.RawURLEncoding.EncodeToString(raw)
}
func ParseHistoryPosition(token string, chunk bool) (HistoryPosition, error) {
	var p HistoryPosition
	if len(token) == 0 || len(token) > sp.MaxHistoryCursorBytes {
		return p, fault("reset_required", "The history cursor is invalid.")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
	var fields []json.RawMessage
	size := 6
	if chunk {
		size = 10
	}
	if err != nil || json.Unmarshal(raw, &fields) != nil || len(fields) != size || string(fields[0]) != "1" {
		return p, fault("reset_required", "The history cursor is invalid.")
	}
	values := make([]string, len(fields)-1)
	for i := range values {
		if json.Unmarshal(fields[i+1], &values[i]) != nil || values[i] == "" {
			return p, fault("reset_required", "The history cursor is invalid.")
		}
	}
	p = HistoryPosition{Source: values[0], SessionID: values[1], Epoch: values[2], Version: values[3], Chunk: chunk}
	if p.Source != "live" && p.Source != "archive" {
		return p, fault("reset_required", "The history cursor source is invalid.")
	}
	validDecimal := func(v string) bool {
		n, e := strconv.ParseUint(v, 10, 63)
		return e == nil && strconv.FormatUint(n, 10) == v
	}
	if chunk {
		p.EntryID, p.Revision, p.SHA256, p.ByteLength, p.Offset = values[4], values[5], values[6], values[7], values[8]
		if !validDecimal(p.Revision) || p.Revision == "0" || !validDecimal(p.ByteLength) || p.ByteLength == "0" || !validDecimal(p.Offset) || len(p.SHA256) != 64 {
			return HistoryPosition{}, fault("reset_required", "The entry cursor is invalid.")
		}
	} else {
		p.Sequence = values[4]
		if !validDecimal(p.Sequence) || p.Sequence == "0" {
			return HistoryPosition{}, fault("reset_required", "The history position is invalid.")
		}
	}
	return p, nil
}
func (p HistoryPosition) Matches(id, epoch, source, version string) bool {
	return p.SessionID == id && p.Epoch == epoch && p.Source == source && p.Version == version
}

func historyItem(id, epoch, source, version string, e sp.TimelineEntry, resources []sp.Resource) (sp.MessageItem, error) {
	body, err := canonicalHistoryJSON(e)
	if err != nil {
		return sp.MessageItem{}, err
	}
	item := sp.MessageItem{EntryID: e.EntryID, EntrySeq: e.EntrySeq, Revision: e.Revision, Kind: e.Kind, Body: body, Resources: []sp.InspectionResource{}}
	if e.Kind == "user_message" {
		item.Role = observationPointer("user")
	}
	if e.Kind == "assistant_message" {
		item.Role = observationPointer("assistant")
	}
	refs := historyResourceReferences(e)
	for _, r := range resources {
		if !refs[r.ResourceID] {
			continue
		}
		if len(item.Resources) == 20 {
			item.ResourcesTruncated = true
			continue
		}
		name := r.Name
		if len(name) > 1024 {
			name = trimUTF8(name, 1024)
			item.ResourcesTruncated = true
		}
		item.Resources = append(item.Resources, sp.InspectionResource{ResourceID: r.ResourceID, Status: r.Status, Name: name, MediaType: r.MediaType, ByteLength: r.ByteLength, SHA256: r.SHA256})
	}
	return item, nil
}

func historyResourceReferences(e sp.TimelineEntry) map[string]bool {
	refs := map[string]bool{}
	for _, field := range []string{"content", "output"} {
		var parts []struct{ Type, ResourceID string }
		_ = json.Unmarshal(e.Data[field], &parts)
		for _, part := range parts {
			if part.Type == "resource" {
				refs[part.ResourceID] = true
			}
		}
	}
	return refs
}

// Coverage describes the whole source before page selection, conversation
// filtering, or replacement of a large body with a content reference.
func historyCoverage(entries []sp.TimelineEntry, resources []sp.Resource) sp.HistoryCoverage {
	for _, entry := range entries {
		if entry.Kind == "tool_call" && string(entry.Data["truncated"]) == "true" {
			return sp.HistoryCoverage{State: "partial", Reason: observationPointer("entry_truncated")}
		}
	}
	present := make(map[string]bool, len(resources))
	for _, resource := range resources {
		if resource.Status != "available" {
			return sp.HistoryCoverage{State: "partial", Reason: observationPointer("resource_unavailable")}
		}
		present[resource.ResourceID] = true
	}
	for _, entry := range entries {
		for id := range historyResourceReferences(entry) {
			if !present[id] {
				return sp.HistoryCoverage{State: "partial", Reason: observationPointer("resource_unavailable")}
			}
		}
	}
	return sp.HistoryCoverage{State: "complete"}
}
func referenceHistoryItem(item sp.MessageItem, id, epoch, source, version string) sp.MessageItem {
	hash := v2.HashBytes(item.Body)
	size := strconv.Itoa(len(item.Body))
	p := HistoryPosition{Source: source, SessionID: id, Epoch: epoch, Version: version, EntryID: item.EntryID, Revision: item.Revision, SHA256: hash, ByteLength: size, Offset: "0", Chunk: true}
	item.Body = nil
	item.Truncated = true
	item.ContentRef = &sp.EntryContentRef{Cursor: p.Cursor(), SHA256: hash, ByteLength: size}
	return item
}
func historyPageFits(page sp.MessagePage, overhead int) bool {
	raw, err := json.Marshal(page)
	return err == nil && overhead >= 0 && len(raw)+overhead <= sp.MaxHistoryResponseBytes
}
func trimUTF8(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return value[:limit]
}

// BuildHistoryPage selects before filtering, then fits whole entries or explicit
// body references. The cursor advances only across entries actually selected.
func BuildHistoryPage(id, epoch, source, version string, entries []sp.TimelineEntry, resources []sp.Resource, token string, limit int, conversation bool, overhead int, now time.Time) (sp.MessagePage, error) {
	out := sp.MessagePage{SessionID: id, HistoryEpoch: epoch, Source: source, Items: []sp.MessageItem{}, Coverage: historyCoverage(entries, resources), ObservedAt: now.UTC()}
	if limit < 1 || limit > 200 || overhead < 0 || overhead >= sp.MaxHistoryResponseBytes {
		return out, fault("invalid_input", "Invalid history page limit or response budget.")
	}
	end := len(entries)
	if token != "" {
		p, err := ParseHistoryPosition(token, false)
		if err != nil {
			return out, err
		}
		if !p.Matches(id, epoch, source, version) {
			return out, fault("reset_required", "The history source changed; restart from the latest page.")
		}
		for end > 0 && number(entries[end-1].EntrySeq) >= number(p.Sequence) {
			end--
		}
	}
	start := end
	for start > 0 && end-start < limit {
		e := entries[start-1]
		if e.Kind == "error" && string(e.Data["code"]) == `"display_budget_exceeded"` {
			return out, fault("upgrade_required", "The controller archive contains a display placeholder instead of the original entry.")
		}
		item, err := historyItem(id, epoch, source, version, e, resources)
		if err != nil {
			return out, err
		}
		candidate := out
		candidate.Items = append([]sp.MessageItem{item}, out.Items...)
		candidate.HasMoreBefore = start > 1
		if candidate.HasMoreBefore {
			cursor := HistoryPosition{Source: source, SessionID: id, Epoch: epoch, Version: version, Sequence: e.EntrySeq}.Cursor()
			candidate.BeforeCursor = &cursor
		} else {
			candidate.BeforeCursor = nil
		}
		if !historyPageFits(candidate, overhead) {
			candidate.Items[0] = referenceHistoryItem(item, id, epoch, source, version)
		}
		if !historyPageFits(candidate, overhead) {
			if start == end {
				return out, fault("resource_limit_exceeded", "History metadata exceeds the response budget.")
			}
			break
		}
		out = candidate
		start--
	}
	if conversation {
		items := []sp.MessageItem{}
		for _, item := range out.Items {
			if item.Kind == "user_message" || item.Kind == "assistant_message" {
				items = append(items, item)
			}
		}
		out.Items = items
	}
	if !historyPageFits(out, overhead) {
		return out, fault("resource_limit_exceeded", "History response exceeds its budget.")
	}
	return out, nil
}
func BuildEntryChunk(id, epoch, source, version string, entries []sp.TimelineEntry, token string, now time.Time) (sp.EntryChunk, error) {
	out := sp.EntryChunk{SessionID: id, HistoryEpoch: epoch, Source: source, ObservedAt: now.UTC()}
	p, err := ParseHistoryPosition(token, true)
	if err != nil {
		return out, err
	}
	if !p.Matches(id, epoch, source, version) {
		return out, fault("reset_required", "The history source changed; restart from the latest page.")
	}
	var body []byte
	for _, e := range entries {
		if e.EntryID == p.EntryID {
			if e.Revision != p.Revision {
				return out, fault("content_changed", "The entry revision changed.")
			}
			body, err = canonicalHistoryJSON(e)
			if err != nil {
				return out, err
			}
			break
		}
	}
	if body == nil {
		return out, fault("content_changed", "The referenced entry is no longer available.")
	}
	if v2.HashBytes(body) != p.SHA256 || strconv.Itoa(len(body)) != p.ByteLength {
		return out, fault("content_changed", "The referenced entry content changed.")
	}
	offset := number(p.Offset)
	if offset > int64(len(body)) || offset < int64(len(body)) && !utf8.RuneStart(body[offset]) {
		return out, fault("reset_required", "The entry offset is invalid.")
	}
	end := int(offset) + sp.MaxEntryChunkBytes
	if end > len(body) {
		end = len(body)
	}
	for end < len(body) && !utf8.RuneStart(body[end]) {
		end--
	}
	out.EntryID, out.Revision, out.SHA256, out.ByteLength, out.Offset = p.EntryID, p.Revision, p.SHA256, p.ByteLength, p.Offset
	out.Fragment = string(body[offset:end])
	out.EOF = end == len(body)
	if !out.EOF {
		p.Offset = strconv.Itoa(end)
		next := p.Cursor()
		out.NextCursor = &next
	}
	return out, nil
}
