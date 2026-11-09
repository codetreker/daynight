package session_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestExternalResourceLedgerPersistsIdentityBudgetPinsAndDeletion(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	id, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Lifecycle: "active"}})
	})
	uploadID, imageID, blobID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	expires := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	spec := sp.ImageUploadSpec{UploadID: uploadID, ImageID: imageID, Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: actor.UserID, Fence: fence}, Name: "image.png", MediaType: "image/png", ByteLength: "10485760", SHA256: string(bytes.Repeat([]byte("a"), 64))}
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: blobID, Spec: spec, ExpiresAt: expires, Receipt: sp.ImageUploadReceipt{UploadID: uploadID, ImageID: imageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0", ExpiresAt: expires.Format(time.RFC3339Nano)}}
	run := func(fn func(store.SessionResourceDAO) error) {
		t.Helper()
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			if _, e := d.LockSession(t.Context(), id); e != nil {
				return e
			}
			return fn(d.(store.SessionResourceDAO))
		})
	}
	run(func(d store.SessionResourceDAO) error {
		u, e := d.SessionResourceUsage(t.Context(), id)
		if e != nil {
			return e
		}
		if u.Bytes != 0 || u.DeleteEpoch != 0 || u.Deleting {
			t.Fatalf("initial usage %+v", u)
		}
		return d.SaveSessionUpload(t.Context(), upload)
	})
	run(func(d store.SessionResourceDAO) error {
		loaded, e := d.SessionUpload(t.Context(), id, uploadID)
		if e != nil {
			return e
		}
		if loaded.Spec != spec || loaded.BlobID != blobID || !loaded.ExpiresAt.Equal(expires) {
			t.Fatal("upload immutable identity changed")
		}
		u, e := d.SessionResourceUsage(t.Context(), id)
		if e != nil {
			return e
		}
		if u.ReservedBytes != 10485760 || u.ReservedResources != 1 || u.UploadIdentities != 1 {
			t.Fatalf("reserved usage %+v", u)
		}
		return d.InsertSessionUploadChunk(t.Context(), store.SessionUploadChunk{SessionID: id, UploadID: uploadID, Offset: 0, ByteLength: 524288, SHA256: spec.SHA256, Path: "exact/0"})
	})
	run(func(d store.SessionResourceDAO) error {
		chunks, e := d.SessionUploadChunks(t.Context(), id, uploadID)
		if e != nil {
			return e
		}
		if len(chunks) != 1 || chunks[0].Path != "exact/0" || chunks[0].ByteLength != 524288 {
			t.Fatalf("chunks %+v", chunks)
		}
		return nil
	})
	media, length, digest := "image/png", "10485760", spec.SHA256
	width, height, frames := 2, 3, 1
	resource := sp.Resource{Revision: "1", ResourceID: blobID, Status: "available", Name: spec.Name, MediaType: &media, ByteLength: &length, SHA256: &digest, Width: &width, Height: &height, FrameCount: &frames}
	run(func(d store.SessionResourceDAO) error {
		if e := d.InsertSessionResource(t.Context(), store.SessionResourceRecord{SessionID: id, Resource: resource, BlobID: blobID, BlobPath: "exact/blob"}); e != nil {
			return e
		}
		upload.Receipt.State = "complete"
		upload.Receipt.Resource = &resource
		return d.SaveSessionUpload(t.Context(), upload)
	})
	run(func(d store.SessionResourceDAO) error {
		items, e := d.ListSessionResources(t.Context(), id)
		if e != nil {
			return e
		}
		if len(items) != 1 || items[0].BlobPath != "exact/blob" || items[0].Resource.Width == nil || *items[0].Resource.Width != 2 {
			t.Fatalf("resource descriptor %+v", items)
		}
		u, e := d.SessionResourceUsage(t.Context(), id)
		if e != nil {
			return e
		}
		if u.Bytes != 10485760 || u.ReservedBytes != 0 || u.Resources != 1 {
			t.Fatalf("committed usage %+v", u)
		}
		for _, kind := range []string{"upload", "operation", "message", "unknown", "native_resume", "archive"} {
			ref := store.SessionResourceReference{SessionID: id, ResourceID: blobID, Kind: kind, ReferenceID: operation}
			if e = d.AddSessionResourceReference(t.Context(), ref); e != nil {
				return e
			}
			if e = d.AddSessionResourceReference(t.Context(), ref); e != nil {
				return e
			}
		}
		n, e := d.SessionResourceReferenceCount(t.Context(), id, blobID)
		if e != nil {
			return e
		}
		if n != 6 {
			t.Fatalf("independent pin count %d", n)
		}
		return d.RemoveSessionResourceReference(t.Context(), store.SessionResourceReference{SessionID: id, ResourceID: blobID, Kind: "upload", ReferenceID: operation})
	})
	lease := uuid.NewString()
	run(func(d store.SessionResourceDAO) error {
		return d.AcquireSessionResourceLease(t.Context(), store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: id, ID: lease, OwnerID: actor.UserID, Kind: "read", ResourceID: blobID, DeleteEpoch: 0})
	})
	run(func(d store.SessionResourceDAO) error {
		epoch, e := d.BeginSessionResourceDeletion(t.Context(), id)
		if e != nil {
			return e
		}
		if epoch != 1 {
			t.Fatalf("delete epoch %d", epoch)
		}
		n, e := d.SessionResourceLeaseCount(t.Context(), id)
		if e != nil {
			return e
		}
		if n != 1 {
			t.Fatalf("deletion erased active reader: %d", n)
		}
		if e = d.AcquireSessionResourceLease(t.Context(), store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: id, ID: uuid.NewString(), OwnerID: actor.UserID, Kind: "read", DeleteEpoch: 0}); e == nil {
			t.Fatal("deleting Session admitted a reader")
		}
		return d.ReleaseSessionResourceLease(t.Context(), id, lease)
	})
	run(func(d store.SessionResourceDAO) error {
		n, e := d.SessionResourceLeaseCount(t.Context(), id)
		if e == nil && n != 0 {
			t.Fatalf("joined lease retained: %d", n)
		}
		return e
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		command := sp.Command{Fence: fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", Payload: json.RawMessage(`{}`)}
		if e := d.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Command: command, Actor: actor, Hash: []byte{1, 2, 3}, Receipt: sp.Operation{Fence: fence, State: "unknown"}}); e != nil {
			return e
		}
		return d.(store.SessionIntentDAO).InsertSessionOperationIntent(t.Context(), id, operation, []byte(`{"original":"bytes"}`))
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		raw, e := d.(store.SessionIntentDAO).SessionOperationIntent(t.Context(), id, operation)
		if e != nil {
			return e
		}
		if string(raw) != `{"original":"bytes"}` {
			t.Fatal("intent bytes changed")
		}
		o, e := d.SessionOperation(t.Context(), id, operation)
		if e == nil && (!bytes.Equal(o.Hash, []byte{1, 2, 3}) || o.Receipt.State != "unknown") {
			t.Fatal("historical operation identity changed")
		}
		return e
	})
	run(func(d store.SessionResourceDAO) error {
		_, e := d.SavedSessionResource(t.Context(), id, uuid.NewString())
		if !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("missing resource: %v", e)
		}
		return nil
	})
}

func TestExternalMediaLedgerReconnectCaptureAndAdmission(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	sessions := make([]string, 33)
	for i := range sessions {
		sessions[i] = uuid.NewString()
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			if e := d.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: sessions[i], ProjectID: project.ID, TaskID: task.ID}, ClaimID: uuid.NewString(), OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "active"}}); e != nil {
				return e
			}
			_, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), sessions[i])
			return e
		})
	}
	id := sessions[0]
	epoch := uuid.NewString()
	hash := bytes.Repeat([]byte{7}, 32)
	source := store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "event", Identity: "1", Digest: hash}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionSourceDAO).SaveSessionSourceHash(t.Context(), source)
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		dao := d.(store.SessionSourceDAO)
		loaded, e := dao.SessionSourceHash(t.Context(), source)
		if e != nil {
			return e
		}
		if !bytes.Equal(loaded, hash) {
			t.Fatal("durable original source digest changed")
		}
		return dao.SaveSessionSourceHash(t.Context(), source)
	})
	changedSource := source
	changedSource.Digest = bytes.Repeat([]byte{8}, 32)
	if _, e := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionSourceDAO).SaveSessionSourceHash(t.Context(), changedSource)
	}); e == nil {
		t.Fatal("source identity overwritten")
	}
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}
	row := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "read", Fence: fence, Body: []byte(`{"offset":"0","limit":1}`)}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row)
	})
	row.Fence.ConnectionEpoch = "2"
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row)
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		m := d.(store.SessionMediaDAO)
		pending, e := m.PendingSessionMediaRequests(t.Context(), id)
		if e != nil {
			return e
		}
		if len(pending) != 1 || pending[0].RequestID != row.RequestID || pending[0].Fence.ConnectionEpoch != "2" {
			t.Fatal("pending original request not rebound", pending)
		}
		row.Complete = true
		row.Result = []byte(`{"bytes":"original"}`)
		return m.SaveSessionMediaRequest(t.Context(), row)
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		m := d.(store.SessionMediaDAO)
		loaded, e := m.SessionMediaRequest(t.Context(), id, row.RequestID)
		if e != nil {
			return e
		}
		var result map[string]string
		if json.Unmarshal(loaded.Result, &result) != nil || !loaded.Complete || result["bytes"] != "original" {
			t.Fatal("remote completion lost", string(loaded.Result))
		}
		pending, e := m.PendingSessionMediaRequests(t.Context(), id)
		if e == nil && len(pending) != 0 {
			t.Fatal("completed request still offered")
		}
		return e
	})
	// The immutable completion cannot be replaced by a reconnect or a changed body.
	for _, kind := range []string{"body", "fence", "result"} {
		changed := row
		switch kind {
		case "body":
			changed.Body = []byte(`{"offset":"1","limit":1}`)
		case "fence":
			changed.Fence.ExecutionGeneration = "2"
		case "result":
			changed.Result = []byte(`{"bytes":"other"}`)
		}
		_, e := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), changed)
		})
		if e == nil {
			t.Fatalf("immutable media %s overwritten", kind)
		}
	}
	capture := store.SessionCaptureRecord{SessionID: id, Request: sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "one-source"}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/image.png"}}, Receipt: sp.ImageCaptureReceipt{State: "reserved"}}
	resource := uuid.NewString()
	capture.Receipt.CaptureID = capture.Request.CaptureID
	capture.Receipt.AttemptID, capture.Receipt.Revision = capture.Request.AttemptID, "1"
	capture.Receipt.Occurrence = capture.Request.Occurrence
	capture.Receipt.ResourceID = &resource
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).SaveSessionCapture(t.Context(), capture)
	})
	v := sp.ValidatedImage{MediaType: "image/png", ByteLength: "10", SHA256: string(bytes.Repeat([]byte("a"), 64)), Width: 2, Height: 3, FrameCount: 1}
	capture.Expected = &store.SessionCaptureState{Receipt: capture.Receipt, Validated: capture.Validated}
	capture.Validated = &v
	capture.Receipt.State = "copying"
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).SaveSessionCapture(t.Context(), capture)
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		resources := d.(store.SessionResourceDAO)
		loaded, e := resources.SessionCapture(t.Context(), id, capture.Request.CaptureID)
		if e != nil {
			return e
		}
		if loaded.Validated == nil || *loaded.Validated != v || *loaded.Receipt.ResourceID != resource {
			t.Fatal("capture recovery changed original identity")
		}
		usage, e := resources.SessionResourceUsage(t.Context(), id)
		if e != nil {
			return e
		}
		if usage.ReservedBytes != 10 || usage.ReservedResources != 1 || usage.UploadIdentities != 1 {
			t.Fatal("capture was omitted from budget", usage)
		}
		unsettled, e := resources.UnsettledSessionResourceWrites(t.Context(), id)
		if e == nil && unsettled != 1 {
			t.Fatalf("copying capture did not prevent seal: %d", unsettled)
		}
		return e
	})
	alias := capture
	alias.Expected = nil
	alias.Request.CaptureID = uuid.NewString()
	alias.Request.Occurrence.ImageID = uuid.NewString()
	_, e := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(t.Context(), alias)
	})
	if e == nil {
		t.Fatal("same sourceKey accepted a fresh capture identity")
	}
	owners := make([]string, 9)
	for i := range owners {
		owners[i] = uuid.NewString()
	}
	for i := 0; i < 32; i++ {
		for n := 0; n < 2; n++ {
			sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
				return d.(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: sessions[i], ID: uuid.NewString(), OwnerID: owners[i/4], Kind: "read"})
			})
		}
		if i == 0 {
			sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
				e := d.(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: id, ID: uuid.NewString(), OwnerID: owners[0], Kind: "write"})
				if e == nil {
					t.Fatal("third Session lease admitted")
				}
				return nil
			})
		}
		if i == 3 {
			sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
				e := d.(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: sessions[4], ID: uuid.NewString(), OwnerID: owners[0], Kind: "archive"})
				if e == nil {
					t.Fatal("ninth account lease admitted")
				}
				return nil
			})
		}
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		e := d.(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: sessions[32], ID: uuid.NewString(), OwnerID: owners[8], Kind: "read"})
		if e == nil {
			t.Fatal("65th deployment lease admitted")
		}
		return nil
	})
}
