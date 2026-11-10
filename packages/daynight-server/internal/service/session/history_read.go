package session

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func historyFault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func historyAvailable(v sp.TaskSessionInspection) error {
	if v.Session.AgentControlMode != nil && *v.Session.AgentControlMode == "herdr" {
		return historyFault("unsupported_mode", "Herdr Sessions contain terminal recordings, not chat messages.")
	}
	if v.Session.Error != nil {
		return historyFault(v.Session.Error.Code, v.Session.Error.Message)
	}
	return nil
}
func (s *History) unavailable(ctx context.Context, p model.Principal, project, task, id string) error {
	status, err := s.backend.TaskArchiveStatus(ctx, p, project, task, id)
	if err != nil {
		return err
	}
	switch status.State {
	case "pending":
		return historyFault("history_pending", "Session history archival is still pending.")
	case "ready":
		return historyFault("reset_required", "The history source changed; restart from the latest page.")
	case "failed":
		return historyFault("history_unavailable", "Session history archival failed.")
	default:
		return historyFault("history_unavailable", "Session history is not available.")
	}
}
func historyObservationTime(v sp.TaskSessionInspection) time.Time {
	if v.Session.ObservedAt != nil {
		return v.Session.ObservedAt.UTC()
	}
	return time.Now().UTC()
}

func historyArchiveContent(archive core.HistoryArchive) (string, []sp.TimelineEntry, []sp.Resource, error) {
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if json.Unmarshal(archive.Bytes(), &header) != nil {
		return "", nil, nil, historyFault("source_corrupt", "The Session archive format is invalid.")
	}
	if header.SchemaVersion == 3 {
		manifest, err := sp.DecodeArchiveManifest(archive.Bytes())
		if err != nil {
			return "", nil, nil, historyFault("source_corrupt", "The Session archive format is invalid.")
		}
		data := archive.TimelineBytes()
		timeline, err := sp.DecodeArchiveTimeline(data)
		if err != nil || manifest.Timeline.SHA256 != v2.HashBytes(data) || manifest.Timeline.ByteLength != strconv.Itoa(len(data)) {
			return "", nil, nil, historyFault("source_corrupt", "The Session archive timeline is invalid.")
		}
		resources := make([]sp.Resource, 0, len(manifest.Resources))
		for _, resource := range manifest.Resources {
			resources = append(resources, resource.Resource)
		}
		return manifest.RecordID, timeline.Entries, resources, nil
	}
	doc, err := sp.DecodeArchive(archive.Bytes())
	if err != nil {
		return "", nil, nil, historyFault("source_corrupt", "The Session archive format is invalid.")
	}
	resources := make([]sp.Resource, 0, len(doc.Resources))
	for _, resource := range doc.Resources {
		resources = append(resources, resource.Resource)
	}
	return doc.SessionID, doc.Entries, resources, nil
}
func (s *History) Read(ctx context.Context, p model.Principal, project, task, id string, in ReadRequest) (*ReadResult[sp.MessagePage], error) {
	if in.Limit == 0 {
		in.Limit = 20
	}
	if in.Limit < 1 || in.Limit > 200 || in.ResponseOverhead < 0 || in.ResponseOverhead >= sp.MaxHistoryResponseBytes {
		return nil, historyFault("invalid_input", "Invalid history page limit or response budget.")
	}
	var position core.HistoryPosition
	if in.Before != "" {
		var err error
		position, err = core.ParseHistoryPosition(in.Before, false)
		if err != nil {
			return nil, err
		}
		if position.SessionID != id {
			return nil, historyFault("reset_required", "The history cursor belongs to another Session.")
		}
	}
	observed, err := s.inspection.Inspect(ctx, p, project, task, id)
	if err != nil {
		return nil, err
	}
	if err = historyAvailable(observed); err != nil {
		return nil, err
	}
	if in.Before != "" && position.Source != observed.Source {
		return nil, historyFault("reset_required", "The history source changed; restart from the latest page.")
	}
	if observed.Source == "live" {
		page, err := s.backend.ReadLivePage(ctx, p, project, task, id, core.LiveHistoryRequest{Epoch: position.Epoch, Before: in.Before, Limit: in.Limit, ResponseOverhead: in.ResponseOverhead, ContentReadVersion: observed.ContentReadVersion})
		if err != nil {
			return nil, err
		}
		if in.Conversation {
			filtered := []sp.MessageItem{}
			for _, item := range page.Items {
				if item.Kind == "user_message" || item.Kind == "assistant_message" {
					filtered = append(filtered, item)
				}
			}
			page.Items = filtered
		}
		return NewReadResult(page, nil), nil
	}
	if observed.Source != "archive" {
		return nil, s.unavailable(ctx, p, project, task, id)
	}
	archive, err := s.backend.TaskArchiveContent(ctx, p, project, task, id)
	if err != nil {
		return nil, err
	}
	result, err := func() (sp.MessagePage, error) {
		if err := ctx.Err(); err != nil {
			return sp.MessagePage{}, err
		}
		archiveID, entries, resources, err := historyArchiveContent(archive)
		if err != nil {
			return sp.MessagePage{}, err
		}
		if archiveID != id {
			return sp.MessagePage{}, historyFault("source_corrupt", "The Session archive identity is inconsistent.")
		}
		hash := v2.HashBytes(archive.Bytes())
		page, err := core.BuildHistoryPage(id, hash, "archive", hash, entries, resources, in.Before, in.Limit, in.Conversation, in.ResponseOverhead, historyObservationTime(observed))
		if err != nil {
			return page, err
		}
		if err = ctx.Err(); err != nil {
			return sp.MessagePage{}, err
		}
		return page, nil
	}()
	if err != nil {
		return nil, errors.Join(err, archive.Close())
	}
	return NewReadResult(result, archive), nil
}
func (s *History) Entry(ctx context.Context, p model.Principal, project, task, id string, in EntryRequest) (*ReadResult[sp.EntryChunk], error) {
	if in.ResponseOverhead < 0 || in.ResponseOverhead >= sp.MaxHistoryResponseBytes {
		return nil, historyFault("invalid_input", "Invalid entry response budget.")
	}
	position, err := core.ParseHistoryPosition(in.Cursor, true)
	if err != nil {
		return nil, err
	}
	if position.SessionID != id {
		return nil, historyFault("reset_required", "The entry cursor belongs to another Session.")
	}
	observed, err := s.inspection.Inspect(ctx, p, project, task, id)
	if err != nil {
		return nil, err
	}
	if err = historyAvailable(observed); err != nil {
		return nil, err
	}
	if position.Source != observed.Source {
		return nil, historyFault("reset_required", "The history source changed; restart from the latest page.")
	}
	var result sp.EntryChunk
	var archive core.HistoryArchive
	if observed.Source == "live" {
		result, err = s.backend.ReadLiveEntry(ctx, p, project, task, id, position.Epoch, in.Cursor)
	} else if observed.Source == "archive" {
		archive, err = s.backend.TaskArchiveContent(ctx, p, project, task, id)
		if err == nil {
			var archiveID string
			var entries []sp.TimelineEntry
			archiveID, entries, _, err = historyArchiveContent(archive)
			if err == nil && archiveID != id {
				err = historyFault("source_corrupt", "The Session archive identity is inconsistent.")
			} else if err == nil {
				hash := v2.HashBytes(archive.Bytes())
				result, err = core.BuildEntryChunk(id, hash, "archive", hash, entries, in.Cursor, historyObservationTime(observed))
			}
		}
	} else {
		err = s.unavailable(ctx, p, project, task, id)
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		raw, e := json.Marshal(result)
		err = e
		if err == nil && len(raw)+in.ResponseOverhead > sp.MaxHistoryResponseBytes {
			err = historyFault("resource_limit_exceeded", "Entry response exceeds its budget.")
		}
	}
	if err != nil {
		if archive != nil {
			err = errors.Join(err, archive.Close())
		}
		return nil, err
	}
	return NewReadResult(result, archive), nil
}
