package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// BotHistoryReclaimRunner holds the original Session lock and confirms each
// transaction before returning. It authorizes only already queued reclamation.
type BotHistoryReclaimRunner func(context.Context, func(store.SessionDAO, store.SessionRecord) error) error

func (s *Engine) SetBotHistoryReclamation(reclaim func(context.Context, string) error) {
	s.botHistoryReclaimRun = reclaim
}

func (s *Execution) ReclaimBotHistoryResourcesUsing(ctx context.Context, id string, run BotHistoryReclaimRunner) error {
	op, err := s.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	var ids []string
	err = run(ctx, func(base store.SessionDAO, r store.SessionRecord) error {
		if r.BotID == nil {
			return nil
		}
		dao, ok := base.(store.BotHistoryWindowDAO)
		if !ok {
			return fault("component_unsupported", "Bot history reclamation requires a server upgrade.")
		}
		var err error
		ids, err = dao.PendingBotHistoryReclaims(ctx, id)
		return err
	})
	if err != nil {
		return err
	}
	var result error
	for _, resource := range ids {
		if err := ctx.Err(); err != nil {
			return errors.Join(result, err)
		}
		result = errors.Join(result, s.reclaimBotHistoryResource(ctx, id, resource, run))
	}
	return result
}

func (s *Execution) reclaimBotHistoryResource(ctx context.Context, id, resource string, run BotHistoryReclaimRunner) (result error) {
	if s.files == nil {
		return fault("component_unsupported", "Resource file storage is unavailable.")
	}
	gate, err := s.files.AcquireGate(ctx, filestorage.PrivateGate, "bot-history-resource/"+id+"/"+resource)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, gate.Close()) }()
	ctx, cancel := filestorage.GateContext(ctx, gate)
	defer cancel()
	var saved store.SessionResourceRecord
	var leases []store.SessionResourceLease
	var path string
	eligible := false
	err = run(ctx, func(base store.SessionDAO, r store.SessionRecord) error {
		if r.BotID == nil {
			return nil
		}
		dao, ok := base.(store.BotHistoryWindowDAO)
		if !ok {
			return fault("component_unsupported", "Bot history reclamation requires a server upgrade.")
		}
		resources, ok := base.(store.SessionResourceDAO)
		if !ok {
			return fault("component_unsupported", "Resource storage is unavailable.")
		}
		count, e := resources.SessionResourceReferenceCount(ctx, id, resource)
		if e != nil {
			return e
		}
		if count != 0 {
			return nil
		}
		saved, e = resources.SavedSessionResource(ctx, id, resource)
		if errors.Is(e, model.ErrNotFound) {
			return dao.CompleteBotHistoryReclaim(ctx, id, resource)
		}
		if e != nil {
			return e
		}
		path, e = BlobAddress(r.Snapshot.Identity.ProjectID, r.Owner, id, saved.BlobID)
		if e != nil {
			return e
		}
		if saved.BlobID == "" || saved.BlobPath != path || saved.HasInlineContent {
			return fault("resource_conflict", "Bot resource reclamation storage identity is inconsistent.")
		}
		settlement, ok := base.(store.SessionResourceSettlementDAO)
		if !ok {
			return fault("component_unsupported", "Resource reclamation requires a server upgrade.")
		}
		eligible, e = settlement.MarkSessionResourceReclaim(ctx, id, resource)
		if e != nil || !eligible {
			return e
		}
		// Keep the original upload identity, but retire its available descriptor
		// before deleting the immutable bytes it used to publish.
		if owners, ok := base.(store.SessionResourceUploadDAO); ok {
			upload, e := owners.SessionUploadByResource(ctx, id, resource)
			if e != nil && !errors.Is(e, model.ErrNotFound) {
				return e
			}
			if e == nil && upload.Receipt.State == "complete" {
				upload.Receipt.State, upload.Receipt.Resource, upload.Receipt.Error = "released", nil, nil
				if e = resources.SaveSessionUpload(ctx, upload); e != nil {
					return e
				}
			}
		}
		leases, e = resources.ListSessionResourceLeases(ctx, id)
		return e
	})
	if err != nil || !eligible {
		return err
	}
	if s.files == nil {
		return fault("component_unsupported", "Resource file storage is unavailable.")
	}
	for _, lease := range leases {
		if lease.ResourceID != "" && lease.ResourceID != resource {
			continue
		}
		gate, e := filestorage.TryAcquireMediaLease(ctx, s.files, "session-resource-lease/"+lease.ID)
		if errors.Is(e, filestorage.ErrGateBusy) {
			return fault("resource_busy", "A Bot history resource reader or writer is still running.")
		}
		if e != nil {
			return e
		}
		defer func() { result = errors.Join(result, gate.Close()) }()
		var cancel context.CancelFunc
		ctx, cancel = filestorage.GateContext(ctx, gate)
		defer cancel()
		if e = run(ctx, func(base store.SessionDAO, _ store.SessionRecord) error {
			return base.(store.SessionResourceDAO).ReleaseSessionResourceLease(ctx, id, lease.ID)
		}); e != nil {
			return e
		}
	}
	// gc_pending excludes every later pin and read lease. The durable queue and
	// quota remain after file failure or an unknown final transaction outcome.
	if err = s.files.Delete(ctx, sessionresource.Bucket, path); err != nil {
		return err
	}
	return run(ctx, func(base store.SessionDAO, _ store.SessionRecord) error {
		if e := base.(store.SessionResourceSettlementDAO).DeleteReclaimedSessionResource(ctx, id, resource); e != nil {
			return e
		}
		return base.(store.BotHistoryWindowDAO).CompleteBotHistoryReclaim(ctx, id, resource)
	})
}
