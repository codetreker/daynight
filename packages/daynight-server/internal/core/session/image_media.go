package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const mediaRequestBodyBytes = 1 << 20

func saveMediaRequest(ctx context.Context, dao store.SessionMediaDAO, row store.SessionMediaRequest) error {
	var body bytes.Buffer
	if err := json.Compact(&body, row.Body); err != nil {
		return fault("invalid_input", "Controller media requests require a valid JSON body.")
	}
	// JSONB readback adds insignificant spaces. Admission measures the compact
	// protocol body so rebinding does not shrink the original byte allowance.
	if body.Len() > mediaRequestBodyBytes {
		return fault("quota_exceeded", "The controller media body exceeds its storage budget.")
	}
	if row.Complete && (row.Result != nil) == (row.Error != nil) || !row.Complete && (row.Result != nil || row.Error != nil) {
		return fault("invalid_input", "Controller media completion requires exactly one result or error.")
	}
	if row.Result != nil && (!json.Valid(row.Result) || bytes.Equal(bytes.TrimSpace(row.Result), []byte("null"))) {
		return fault("invalid_input", "Controller media results require a nonnull JSON value.")
	}
	row.Body = body.Bytes()
	return dao.SaveSessionMediaRequest(ctx, row)
}

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
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
			if !write {
				return denied()
			}
			return work(tx, r)
		})
	}
	return s.controllerMediaWithAccess(ctx, id, requestID, action, body, access)
}
func (s *Execution) controllerMediaWithAccess(ctx context.Context, id, requestID, action string, body any, access imageStorageAccess) (json.RawMessage, error) {
	wire := encode(body)
	if len(wire) > mediaRequestBodyBytes {
		return nil, fault("quota_exceeded", "The controller media body exceeds its storage budget.")
	}
	identity, _, err := compactMediaPayload(wire, action == "write")
	if err != nil {
		return nil, err
	}
	var completedRow store.SessionMediaRequest
	var out json.RawMessage
	var remote *sp.ImageError
	complete := false
	observe := func(create bool) error {
		return access(ctx, func(tx *operationTx, r *record) error {
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
				row = store.SessionMediaRequest{SessionID: id, RequestID: requestID, Action: action, Fence: r.Snapshot.ControllerFence, Body: identity}
				return saveMediaRequest(ctx, d, row)
			}
			row, e = normalizeMediaRequest(ctx, d, row)
			if e != nil {
				return e
			}
			if row.Action != action || row.Fence.Fence != r.Snapshot.Fence || !jsonEqual(row.Body, identity) {
				return fault("resource_conflict", "Media request identity changed.")
			}
			if !row.Complete {
				if e := onlineContent(r, s.now()); e != nil {
					return e
				}
			}
			if !row.Complete && row.Fence.ConnectionEpoch != r.Snapshot.ConnectionEpoch {
				row.Fence = r.Snapshot.ControllerFence
				if e = saveMediaRequest(ctx, d, row); e != nil {
					return e
				}
			}
			out, remote, complete = row.Result, row.Error, row.Complete
			completedRow = row
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
	if mediaRead(action) {
		payload, rawData, err := compactMediaPayload(out, true)
		if err != nil {
			return nil, err
		}
		_, has, err := mediaPayloadIdentity(payload)
		if err != nil {
			return nil, err
		}
		if has {
			var original []byte
			if rawData {
				var v struct {
					Data string `json:"data"`
				}
				_ = json.Unmarshal(out, &v)
				original, _ = base64.StdEncoding.Strict().DecodeString(v.Data)
			}
			raw, check, finish, err := s.mediaFileIO(ctx, access, completedRow, payload, original)
			if err != nil {
				return nil, err
			}
			err = access(ctx, func(tx *operationTx, r *record) error {
				if err := check(tx, r); err != nil {
					return err
				}
				if !rawData {
					return nil
				}
				d, e := mediaDAO(tx)
				if e != nil {
					return e
				}
				row, e := d.SessionMediaRequest(ctx, id, requestID)
				if e != nil {
					return e
				}
				compact, _, e := compactMediaPayload(row.Result, true)
				if e != nil {
					return e
				}
				if !jsonEqual(compact, payload) {
					return conflict()
				}
				row.Expected = mediaExpected(row)
				row.Result = payload
				return saveMediaRequest(ctx, d, row)
			})
			err = errors.Join(err, finish())
			if err != nil {
				return nil, err
			}
			if rawData {
				return out, nil
			}
			return raw, nil
		}
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
	rows, e := d.PendingSessionMediaRequests(ctx, r.Snapshot.Fence)
	if e != nil {
		return nil, e
	}
	out := []map[string]any{}
	for _, row := range rows {
		row, e = normalizeMediaRequest(ctx, d, row)
		if e != nil {
			return nil, e
		}
		if row.Fence.Fence != r.Snapshot.Fence {
			continue
		}
		if row.Fence != r.Snapshot.ControllerFence {
			row.Fence = r.Snapshot.ControllerFence
			if e = saveMediaRequest(ctx, d, row); e != nil {
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
	row, e = normalizeMediaRequest(ctx, d, row)
	if e != nil {
		return nil, e
	}
	// Admission refusals and transient release storage failures do not establish
	// a terminal outcome. Reoffer only the original durable request; an existing
	// terminal result and its identity remain unchanged.
	if m.MediaError != nil && (m.MediaError.Code == "rate_limited" || row.Action == "release" && m.MediaError.Code == "release_storage_unavailable") {
		return nil, nil
	}
	if row.Complete && mediaRead(row.Action) && row.Error == nil {
		compact, changed, err := compactMediaPayload(row.Result, true)
		if err != nil {
			return nil, err
		}
		if !jsonEqual(compact, m.MediaResult) || m.MediaError != nil {
			return nil, conflict()
		}
		if changed {
			row.Expected = mediaExpected(row)
		}
	}
	row.Complete = true
	row.Error = m.MediaError
	row.Result = nil
	if m.MediaError == nil {
		row.Result = m.MediaResult
		_, hasRaw, err := compactMediaPayload(row.Result, mediaRead(row.Action))
		if err != nil {
			return nil, err
		}
		if hasRaw {
			return nil, fault("resource_conflict", "Media bytes must be durable before receipt completion.")
		}
	}
	if e = saveMediaRequest(ctx, d, row); e != nil {
		return nil, e
	}
	return nil, nil
}
