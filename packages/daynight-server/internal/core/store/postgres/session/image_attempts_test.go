package session_test

import (
	"bytes"
	"errors"
	"testing"
	"time"

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
func TestExternalCaptureAttemptsRequireReleasedStagingAndNeverRewind(t *testing.T) {
	db, id, actor := imageLedgerSession(t)
	request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: uuid.NewString()}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	resource := uuid.NewString()
	c := store.SessionCaptureRecord{SessionID: id, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: request.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "reserved", ResourceID: &resource}}
	save := func(row store.SessionCaptureRecord) error {
		_, e := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(t.Context(), row)
		})
		return e
	}
	if e := save(c); e != nil {
		t.Fatal(e)
	}
	c.Receipt.State, c.Receipt.ResourceID, c.Receipt.Error, c.Receipt.Revision = "failed", nil, &sp.ImageError{Code: "invalid_image", Message: "Rejected original."}, "2"
	if e := save(c); e != nil {
		t.Fatal(e)
	}
	expires := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: request.AttemptID, ImageID: request.Occurrence.ImageID, ByteLength: "10"}, ExpiresAt: expires, Receipt: sp.ImageUploadReceipt{State: "failed"}}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload)
	})
	retry := c
	retry.Receipt.AttemptID = uuid.NewString()
	retry.Receipt.State, retry.Receipt.ResourceID, retry.Receipt.Error, retry.Receipt.Revision = "reserved", &resource, nil, "3"
	if e := save(retry); e == nil {
		t.Fatal("new attempt admitted before actual staging release")
	}
	upload.StorageReleased = true
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload)
	})
	if e := save(retry); e != nil {
		t.Fatal("released staging did not permit retry", e)
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		loaded, e := d.(store.SessionResourceDAO).SessionCaptureByImage(t.Context(), id, request.Occurrence.ImageID)
		if e != nil {
			return e
		}
		if loaded.Request != request || loaded.Receipt.AttemptID != retry.Receipt.AttemptID {
			t.Fatal("retry replaced original request", loaded)
		}
		usage, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		if e == nil && (usage.ReservedBytes != sp.MaxImageBytes || usage.ReservedResources != 1) {
			t.Fatal("retry reservation lost or doubled", usage)
		}
		return e
	})
	if e := save(c); e == nil {
		t.Fatal("late original attempt overwrote current receipt")
	}
	duplicate := retry
	duplicate.Request.CaptureID = uuid.NewString()
	duplicate.Request.Occurrence.ImageID = uuid.NewString()
	duplicate.Request.Occurrence.SourceKey = uuid.NewString()
	if e := save(duplicate); e == nil {
		t.Fatal("two captures share an attempt identity")
	}
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "10", SHA256: string(bytes.Repeat([]byte("a"), 64)), Width: 2, Height: 3, FrameCount: 1}
	retry.Validated = &validated
	retry.Receipt.State, retry.Receipt.Revision = "copying", "4"
	if e := save(retry); e != nil {
		t.Fatal(e)
	}
	regression := retry
	regression.Receipt.State = "reserved"
	if e := save(regression); e == nil {
		t.Fatal("copying attempt rewound")
	}
	retry.Receipt.State, retry.Receipt.Revision = "committed", "5"
	retry.Receipt.Resource = &sp.Resource{Revision: "1", ResourceID: resource, Status: "available"}
	if e := save(retry); e != nil {
		t.Fatal(e)
	}
	if e := save(retry); e != nil {
		t.Fatal("exact committed receipt replay failed", e)
	}
	regression = retry
	regression.Receipt.State = "failed"
	if e := save(regression); e == nil {
		t.Fatal("saved occurrence downgraded")
	}
	regression = retry
	regression.Request.Locator.URL = "https://replacement.example/image.png"
	if e := save(regression); e == nil {
		t.Fatal("original locator changed")
	}
}
func TestExternalSourceHashWindowPrunesExactBoundaryAndOldEpoch(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	epoch := uuid.NewString()
	digest := bytes.Repeat([]byte{7}, 32)
	save := func(h store.SessionSourceHash) error {
		_, e := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionSourceDAO).SaveSessionSourceHash(t.Context(), h)
		})
		return e
	}
	h := store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "event", Digest: digest}
	for _, item := range []struct {
		id      string
		through int64
	}{{"1", 1}, {"2", 2}, {"2049", 2049}} {
		h.Identity, h.Through = item.id, item.through
		if e := save(h); e != nil {
			t.Fatal(e)
		}
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		query := h
		query.Identity = "1"
		if _, e := d.(store.SessionSourceDAO).SessionSourceHash(t.Context(), query); !errors.Is(e, model.ErrNotFound) {
			t.Fatal("expired ACK boundary retained", e)
		}
		query.Identity = "2"
		_, e := d.(store.SessionSourceDAO).SessionSourceHash(t.Context(), query)
		return e
	})
	old := h
	h.SourceEpoch = uuid.NewString()
	h.Identity, h.Through = "1", 1
	if e := save(h); e != nil {
		t.Fatal(e)
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		_, e := d.(store.SessionSourceDAO).SessionSourceHash(t.Context(), old)
		if !errors.Is(e, model.ErrNotFound) {
			t.Fatal("old epoch hashes retained", e)
		}
		return nil
	})
	mustQueryExec(t, db, `DELETE FROM session_source_hashes WHERE session_id=$1`, id)
	mustQueryExec(t, db, `INSERT INTO session_source_hashes(session_id,source_epoch,kind,identity,digest,source_seq) SELECT $1,$2,'batch',lpad(n::text,36,'0'),$3,3000 FROM generate_series(1,8192) n`, id, h.SourceEpoch, digest)
	h.Identity, h.Through = "new", 3000
	if e := save(h); e == nil {
		t.Fatal("source ACK metadata capacity exceeded")
	}
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
