package session

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ArchiveCleanup coordinates committed expiry with crash-released filesystem
// permits. It borrows both dependencies; its caller must drain it before closing
// either. Each call processes one bounded page and returns the next scan cursor.
type ArchiveCleanup struct {
	db     store.ArchiveCleanupStore
	files  filestorage.Storage
	now    func() time.Time
	expire func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error)
}

func NewArchiveCleanup(db store.ArchiveCleanupStore, files filestorage.Storage) *ArchiveCleanup {
	return &ArchiveCleanup{db: db, files: files, now: time.Now, expire: core.ExpireArchive}
}

func (s *ArchiveCleanup) Sweep(ctx context.Context, after string) (string, error) {
	targets, err := s.db.ListArchiveCleanup(ctx, after, 32)
	if err != nil {
		return after, err
	}
	var result error
	for _, target := range targets {
		if err := ctx.Err(); err != nil {
			return after, errors.Join(result, err)
		}
		attempt, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := s.clean(attempt, target)
		cancel()
		result = errors.Join(result, err)
		after = target.SessionID
	}
	if len(targets) < 32 {
		after = ""
	}
	return after, result
}

func (s *ArchiveCleanup) write(ctx context.Context, target store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) error {
	completion, err := s.db.WriteArchiveCleanup(ctx, target, work)
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("archive cleanup transaction did not confirm commit")
	}
	return nil
}

func (s *ArchiveCleanup) clean(ctx context.Context, target store.ArchiveCleanupTarget) (result error) {
	var expired bool
	if err := s.write(ctx, target, func(scope store.ArchiveCleanupScope) error {
		var err error
		expired, err = s.expire(ctx, scope, s.now())
		return err
	}); err != nil {
		return err
	}
	if !expired {
		return nil
	}
	// Admission is now closed. A still-open response or upload retains this
	// original-owner gate, so no database connection is held while it drains.
	permit, err := s.files.TryAcquireResidency(ctx, "session/archive/owner/"+target.OwnerID)
	if errors.Is(err, filestorage.ErrGateBusy) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, permit.Close()) }()
	var resources []store.SessionResourceRecord
	var leases []store.SessionResourceLease
	if err := s.write(ctx, target, func(scope store.ArchiveCleanupScope) error {
		if scope.Target().ExpiredAt == nil {
			return errors.New("archive cleanup lost expiration barrier")
		}
		dao, ok := scope.SessionDAO().(store.SessionResourceDAO)
		if !ok {
			return errors.New("archive cleanup requires resource storage")
		}
		var err error
		resources, err = dao.ListSessionResources(ctx, target.SessionID)
		if err != nil {
			return err
		}
		leases, err = dao.ListSessionResourceLeases(ctx, target.SessionID)
		return err
	}); err != nil {
		return err
	}
	for _, lease := range leases {
		gate, err := filestorage.TryAcquireMediaLease(ctx, s.files, "session-resource-lease/"+lease.ID)
		if errors.Is(err, filestorage.ErrGateBusy) {
			return nil
		}
		if err != nil {
			return err
		}
		defer func() { result = errors.Join(result, gate.Close()) }()
		if err := s.write(ctx, target, func(scope store.ArchiveCleanupScope) error {
			return scope.SessionDAO().(store.SessionResourceDAO).ReleaseSessionResourceLease(ctx, target.SessionID, lease.ID)
		}); err != nil {
			return err
		}
	}
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, target.ProjectID, target.SessionID)
	if err != nil {
		return err
	}
	if err := s.files.DeleteSessionArchives(ctx, namespace); err != nil {
		return err
	}
	for _, resource := range resources {
		if !resource.GCPending {
			continue
		}
		if resource.BlobID != "" {
			path, err := core.BlobAddress(target.ProjectID, target.OwnerID, target.SessionID, resource.BlobID)
			if err != nil {
				return err
			}
			if path != resource.BlobPath {
				return errors.New("expired resource path disagrees with its namespace")
			}
			if err := s.files.Delete(ctx, sessionresource.Bucket, path); err != nil {
				return err
			}
		} else if !resource.HasInlineContent && resource.Resource.Status == "available" {
			return errors.New("expired resource has no physical or inline content")
		}
		if err := s.write(ctx, target, func(scope store.ArchiveCleanupScope) error {
			dao, ok := scope.SessionDAO().(store.SessionResourceSettlementDAO)
			if !ok {
				return errors.New("archive cleanup requires resource settlement")
			}
			return dao.DeleteReclaimedSessionResource(ctx, target.SessionID, resource.Resource.ResourceID)
		}); err != nil {
			return err
		}
	}
	return s.write(ctx, target, func(scope store.ArchiveCleanupScope) error {
		return scope.CompleteArchiveCleanup(ctx, s.now().UTC())
	})
}
