package session

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func mediaDAO(tx *operationTx) (store.SessionMediaDAO, error) {
	d, ok := tx.dao.(store.SessionMediaDAO)
	if !ok {
		return nil, fault("component_unsupported", "Persistent controller media requires a server upgrade.")
	}
	return d, nil
}
func mediaIdentity(id, action string) string {
	return uuid.NewSHA1(uuid.MustParse(id), []byte(action)).String()
}
func (s *Execution) controllerMedia(ctx context.Context, p model.Principal, project, taskID, id, requestID, action string, body any) (json.RawMessage, error) {
	var out json.RawMessage
	var remote *sp.ImageError
	complete := false
	observe := func(create bool) error {
		return s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
			if !write {
				return denied()
			}
			if r.Snapshot.ContentRevision != 2 {
				return fault("component_unsupported", "Upgrade the original controller for media operations.")
			}
			d, e := mediaDAO(tx)
			if e != nil {
				return e
			}
			row, e := d.SessionMediaRequest(ctx, id, requestID)
			if e != nil {
				if !create || !errors.Is(e, model.ErrNotFound) {
					return e
				}
				if e := onlineContent(r, s.now()); e != nil {
					return e
				}
				row = store.SessionMediaRequest{SessionID: id, RequestID: requestID, Action: action, Fence: r.Snapshot.ControllerFence, Body: encode(body)}
				return d.SaveSessionMediaRequest(ctx, row)
			}
			if row.Action != action || row.Fence.Fence != r.Snapshot.Fence || !jsonEqual(row.Body, encode(body)) {
				return fault("resource_conflict", "Media request identity changed.")
			}
			if !row.Complete {
				if e := onlineContent(r, s.now()); e != nil {
					return e
				}
			}
			if !row.Complete && row.Fence.ConnectionEpoch != r.Snapshot.ConnectionEpoch {
				row.Fence = r.Snapshot.ControllerFence
				if e = d.SaveSessionMediaRequest(ctx, row); e != nil {
					return e
				}
			}
			out, remote, complete = row.Result, row.Error, row.Complete
			return nil
		})
	}
	if e := observe(true); e != nil {
		return nil, e
	}
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for !complete {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, fault("media_outcome_unknown", "Query the original media identity before retrying.")
		case <-ticker.C:
			if e := observe(false); e != nil {
				return nil, e
			}
		}
	}
	if remote != nil {
		return nil, fault(remote.Code, remote.Message)
	}
	return out, nil
}
func (s *Execution) mediaOffers(ctx context.Context, tx *operationTx, r *record) ([]map[string]any, error) {
	if r.Snapshot.ContentRevision != 2 {
		return nil, nil
	}
	d, e := mediaDAO(tx)
	if e != nil {
		return nil, e
	}
	rows, e := d.PendingSessionMediaRequests(ctx, r.Snapshot.SessionID)
	if e != nil {
		return nil, e
	}
	out := []map[string]any{}
	for _, row := range rows {
		if row.Fence.Fence != r.Snapshot.Fence {
			continue
		}
		if row.Fence != r.Snapshot.ControllerFence {
			row.Fence = r.Snapshot.ControllerFence
			if e = d.SaveSessionMediaRequest(ctx, row); e != nil {
				return nil, e
			}
		}
		if row.Action == "write" || row.Action == "complete" {
			var body struct {
				UploadID string `json:"uploadId"`
			}
			if json.Unmarshal(row.Body, &body) == nil && body.UploadID != "" {
				if media, ok := tx.dao.(store.SessionResourceDAO); ok {
					upload, err := media.SessionUpload(ctx, r.Snapshot.SessionID, body.UploadID)
					if err != nil {
						return nil, err
					}
					if upload.Receipt.State == "released" || upload.Receipt.State == "expired" || upload.Receipt.State == "failed" {
						continue
					}
				}
			}
		}
		msg := envelope(r, "image_request")
		msg["requestId"], msg["action"], msg["body"] = row.RequestID, row.Action, json.RawMessage(row.Body)
		out = append(out, msg)
	}
	return out, nil
}
func (s *Execution) acceptMediaResponse(ctx context.Context, tx *operationTx, r *record, m sp.ControllerMessage) (map[string]any, error) {
	d, e := mediaDAO(tx)
	if e != nil {
		return nil, e
	}
	row, e := d.SessionMediaRequest(ctx, r.Snapshot.SessionID, m.RequestID)
	if errors.Is(e, model.ErrNotFound) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if row.Fence != m.ControllerFence || row.Action != m.Action {
		return nil, conflict()
	}
	// Controller rate admission rejects before executing media work. Keep the
	// original request pending so a later offer can use the same durable identity.
	if m.MediaError != nil && m.MediaError.Code == "rate_limited" {
		return nil, nil
	}
	row.Complete = true
	row.Error = m.MediaError
	if m.MediaError == nil {
		row.Result = m.MediaResult
	}
	if e = d.SaveSessionMediaRequest(ctx, row); e != nil {
		return nil, e
	}
	return nil, nil
}
