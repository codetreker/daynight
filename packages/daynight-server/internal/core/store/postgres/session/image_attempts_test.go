package session_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func imageLedgerSession(t *testing.T) (*postgres.Store, string, model.Principal) {
	t.Helper()
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	id := uuid.NewString()
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		if e := d.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: uuid.NewString(), OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "active"}}); e != nil {
			return e
		}
		_, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		return e
	})
	return db, id, actor
}
func TestExternalSourceHashPrunesExplicitBoundaryAndOldEpoch(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	epoch := uuid.NewString()
	digest := bytes.Repeat([]byte{7}, 32)
	h := store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "event", Digest: digest}
	for _, item := range []struct {
		id      string
		through int64
	}{{"1", 1}, {"2", 2}, {"2049", 2049}} {
		h.Identity, h.Through = item.id, item.through
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			return base.(store.SessionSourceDAO).SaveSessionSourceHash(t.Context(), h)
		})
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceDAO)
		if e := dao.PruneSessionSourceHashes(t.Context(), id, epoch, 1); e != nil {
			return e
		}
		query := h
		query.Identity = "1"
		if _, e := dao.SessionSourceHash(t.Context(), query); !errors.Is(e, model.ErrNotFound) {
			t.Fatal("explicit cutoff retained its boundary", e)
		}
		query.Identity = "2"
		if _, e := dao.SessionSourceHash(t.Context(), query); e != nil {
			return e
		}
		count, e := dao.SessionSourceHashCount(t.Context(), id)
		if e != nil || count != 2 {
			t.Fatal("explicit prune removed a newer identity", count, e)
		}
		return nil
	})
	old := h
	h.SourceEpoch = uuid.NewString()
	h.Identity, h.Through = "1", 1
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceDAO)
		if e := dao.SaveSessionSourceHash(t.Context(), h); e != nil {
			return e
		}
		return dao.PruneSessionSourceHashes(t.Context(), id, h.SourceEpoch, -1)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceDAO)
		if _, e := dao.SessionSourceHash(t.Context(), old); !errors.Is(e, model.ErrNotFound) {
			t.Fatal("old epoch hashes retained", e)
		}
		count, e := dao.SessionSourceHashCount(t.Context(), id)
		if e != nil || count != 1 {
			t.Fatal("negative cutoff removed a current nonnegative sequence", count, e)
		}
		_, e = dao.SessionSourceHash(t.Context(), h)
		return e
	})
}

func TestExternalResourceVolumeIncludesTemporaryHistoryAndTimelineCopies(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionArchiveDAO).SaveSessionArchiveBundle(t.Context(), store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "active", Revision: 1, Identity: []byte(`{}`), Resources: []byte(`[]`), Ledger: []byte(`{}`)})
	})
	var baseline int64
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		u, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		baseline = u.GlobalReservedBytes
		return e
	})
	files := []store.ArchiveBundleFile{
		{SessionID: id, FileID: uuid.NewString(), Purpose: "history", SHA256: string(bytes.Repeat([]byte("a"), 64)), ByteLength: 100, AcceptedOffset: 100, State: "complete", Path: "original/history"},
		{SessionID: id, FileID: uuid.NewString(), Purpose: "timeline", SHA256: string(bytes.Repeat([]byte("b"), 64)), ByteLength: 300, State: "receiving", Path: "original/timeline"},
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		for _, file := range files {
			if e := d.(store.SessionArchiveDAO).SaveSessionArchiveFile(t.Context(), file); e != nil {
				return e
			}
		}
		u, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		if e == nil && (u.GlobalReservedBytes != baseline+500 || u.ReservedBytes != 0 || u.ReservedResources != 0) {
			t.Fatal("temporary archive metadata copies omitted or charged as image resources", u, baseline)
		}
		return e
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		for _, file := range files {
			file.StagingReleased = true
			file.State, file.AcceptedOffset = "complete", file.ByteLength
			if e := d.(store.SessionArchiveDAO).SaveSessionArchiveFile(t.Context(), file); e != nil {
				return e
			}
		}
		u, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		if e == nil && u.GlobalReservedBytes != baseline {
			t.Fatal("released metadata stage still reserved", u, baseline)
		}
		return e
	})
}
