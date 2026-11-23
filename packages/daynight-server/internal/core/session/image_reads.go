package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

var errPrivateSessionResource = fmt.Errorf("private Session resource: %w", model.ErrNotFound)

func (s *Execution) savedResource(ctx context.Context, p model.Principal, project, taskID, id, resourceID string) (content []byte, descriptor sp.Resource, result error) {
	if s.files == nil {
		return nil, descriptor, fault("component_unsupported", "Resource storage is unavailable.")
	}
	var saved store.SessionResourceRecord
	lease := uuid.NewString()
	ioContext, finishIO, ioErr := s.beginImageIO(ctx, id, lease)
	if ioErr != nil {
		return nil, descriptor, ioErr
	}
	ctx = ioContext
	defer func() { result = joinImageCleanup(result, finishIO) }()
	// Immutable originals belong to their original Session, even after the Task
	// starts another claim. Ordinary archive access retains the deletion barrier.
	err := s.archiveRun(ctx, p, project, taskID, id, false, func(a *Access) error {
		tx, r := a.tx, a.record
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		saved, e = d.SavedSessionResource(ctx, id, resourceID)
		if e != nil {
			return e
		}
		if saved.BlobID == "" && saved.BlobPath == "" {
			return model.ErrNotFound
		}
		if saved.BlobID == "" || saved.BlobPath == "" {
			return fault("resource_conflict", "Saved resource storage identity is corrupt.")
		}
		visible, e := d.SessionResourceReadableBy(ctx, id, resourceID, p.UserID)
		if e != nil {
			return e
		}
		if !visible {
			return errPrivateSessionResource
		}
		if e = s.admitImageRate(ctx, tx, p.UserID, "observe"); e != nil {
			return e
		}
		path, e := BlobAddress(project, r.Owner, id, saved.BlobID)
		if e != nil {
			return e
		}
		if path != saved.BlobPath || saved.Resource.Status != "available" || saved.Resource.SHA256 == nil || saved.Resource.ByteLength == nil || number(*saved.Resource.ByteLength) > sp.MaxImageBytes {
			return fault("resource_conflict", "Saved resource descriptor is corrupt.")
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		return acquireImageResourceLease(ctx, d, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: r.Owner, Kind: "read", ResourceID: resourceID, DeleteEpoch: usage.DeleteEpoch})
	})
	if err != nil {
		return nil, descriptor, err
	}
	defer func() { result = errors.Join(result, s.releaseImageLease(ctx, p, project, taskID, id, lease)) }()
	object, err := s.files.Open(ctx, sessionresource.Bucket, saved.BlobPath)
	if err != nil {
		return nil, descriptor, err
	}
	data, readErr := io.ReadAll(io.LimitReader(object.Body, sp.MaxImageBytes+1))
	err = errors.Join(readErr, object.Body.Close())
	if err != nil {
		return nil, descriptor, err
	}
	digest := sha256.Sum256(data)
	if object.Info.Size != int64(len(data)) || int64(len(data)) != number(*saved.Resource.ByteLength) || hex.EncodeToString(digest[:]) != *saved.Resource.SHA256 {
		return nil, descriptor, fault("resource_conflict", "Saved resource content is missing or corrupt.")
	}
	// Revocation and deletion racing the read cannot publish a late successful body.
	err = s.archiveRun(ctx, p, project, taskID, id, false, func(a *Access) error {
		tx := a.tx
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting {
			return fault("resource_conflict", "Session resource deletion has begun.")
		}
		visible, e := d.SessionResourceReadableBy(ctx, id, resourceID, p.UserID)
		if e != nil {
			return e
		}
		if !visible {
			return errPrivateSessionResource
		}
		return nil
	})
	if err != nil {
		return nil, descriptor, err
	}
	return data, saved.Resource, nil
}
func (s *Execution) ReadResource(ctx context.Context, p model.Principal, project, taskID, id string, input sp.ImageReadRequest) (sp.ImageReadChunk, error) {
	var out sp.ImageReadChunk
	if _, e := sp.DecodeImageReadRequest(encode(input)); e != nil {
		return out, fault("invalid_input", "Invalid resource read range.")
	}
	data, descriptor, e := s.savedResource(ctx, p, project, taskID, id, input.ResourceID)
	if e != nil {
		return out, e
	}
	offset := number(input.Offset)
	if offset > int64(len(data)) {
		return out, fault("invalid_input", "Resource read offset exceeds its original length.")
	}
	end := min(offset+int64(input.Limit), int64(len(data)))
	out = sp.ImageReadChunk{ResourceID: input.ResourceID, SHA256: *descriptor.SHA256, ByteLength: *descriptor.ByteLength, Offset: input.Offset, Data: base64.StdEncoding.EncodeToString(data[offset:end]), EOF: end == int64(len(data))}
	return out, nil
}
func (s *Execution) ImageCapabilities(ctx context.Context, p model.Principal, project, taskID, id string) (map[string]any, error) {
	var out map[string]any
	err := s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, _ bool) error {
		if e := s.admitImageRate(ctx, tx, p.UserID, "observe"); e != nil {
			return e
		}
		if r.Snapshot.ContentRevision != 2 || r.Snapshot.Capabilities.Images == nil {
			return fault("component_unsupported", "Upgrade the original controller to use Session images.")
		}
		if e := s.syncImageBudget(ctx, tx, r); e != nil {
			return e
		}
		out = map[string]any{"contentRevision": 2, "capabilities": r.Snapshot.Capabilities.Images, "budget": r.Snapshot.ImageBudget}
		return nil
	})
	return out, err
}
func imageBudget(u store.SessionResourceUsage) *sp.ImageBudget {
	return &sp.ImageBudget{Revision: "1", MaxBytes: decimal(sp.MaxSessionResourceBytes), CommittedBytes: decimal(u.Bytes), ReservedBytes: "0", MaxResources: sp.MaxSessionResources, CommittedResources: u.Resources, ReservedResources: 0}
}
