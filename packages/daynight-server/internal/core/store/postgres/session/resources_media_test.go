package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testFailedPreparationAndOriginalReleasePersistIndependentlyOfQuotaSettlement(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}
	spec := sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: actor.UserID, Fence: fence.Fence}, Name: "original.png", MediaType: "image/png", ByteLength: "8", SHA256: archiveHashOf("original")}
	encode := func(value any) json.RawMessage {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	prepare := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewSHA1(uuid.MustParse(spec.UploadID), []byte("prepare")).String(), Action: "prepare", Fence: fence, Body: encode(spec), Complete: true, Error: &sp.ImageError{Code: "budget_exceeded", Message: "Original preparation was rejected."}}
	receipt := sp.LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "released", AcceptedOffset: "0"}
	release := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewSHA1(uuid.MustParse(spec.UploadID), []byte("release")).String(), Action: "release", Fence: fence, Body: encode(map[string]any{"uploadId": spec.UploadID, "spec": spec}), Complete: true, Result: encode(receipt)}
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: spec, ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour), Receipt: sp.ImageUploadReceipt{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "released", AcceptedOffset: "0"}}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		if err := base.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload); err != nil {
			return err
		}
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), prepare)
	})
	assertRelease := func(released bool) {
		t.Helper()
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			resources := base.(store.SessionResourceDAO)
			usage, err := resources.SessionResourceUsage(t.Context(), id)
			if err != nil {
				return err
			}
			saved, err := resources.SessionUpload(t.Context(), id, spec.UploadID)
			if err == nil && (usage.Bytes != 0 || usage.Resources != 0 || saved.StorageReleased != released || saved.Spec != spec) {
				t.Fatal("original identity or release state changed", usage, saved)
			}
			return err
		})
	}
	assertRelease(false)
	rollback := errors.New("release transaction rolled back")
	_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), release); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		if _, err := base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), id, release.RequestID); !errors.Is(err, model.ErrNotFound) {
			t.Fatal("rollback published release", err)
		}
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), release)
	})
	assertRelease(false)
	for _, replacement := range []store.SessionMediaRequest{
		{SessionID: id, RequestID: prepare.RequestID, Action: "prepare", Fence: fence, Body: encode(spec), Complete: true, Result: encode(receipt)},
		{SessionID: id, RequestID: release.RequestID, Action: "release", Fence: fence, Body: encode(map[string]any{"uploadId": spec.UploadID}), Complete: true, Result: encode(receipt)},
	} {
		_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), replacement)
		})
		var conflict *model.Fault
		if !errors.As(err, &conflict) || conflict.Code != "resource_conflict" {
			t.Fatal("immutable original result or release body was replaced", err)
		}
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		media := base.(store.SessionMediaDAO)
		original, err := media.SessionMediaRequest(t.Context(), id, prepare.RequestID)
		if err != nil {
			return err
		}
		if !original.Complete || original.Result != nil || original.Error == nil || *original.Error != *prepare.Error {
			t.Fatal("release replaced definitive prepare failure", original)
		}
		confirmed, err := media.SessionMediaRequest(t.Context(), id, release.RequestID)
		if err != nil {
			return err
		}
		var body struct {
			UploadID string             `json:"uploadId"`
			Spec     sp.ImageUploadSpec `json:"spec"`
		}
		var got sp.LocalImagePreparation
		if !confirmed.Complete || confirmed.Error != nil || json.Unmarshal(confirmed.Body, &body) != nil || body.UploadID != spec.UploadID || body.Spec != spec || json.Unmarshal(confirmed.Result, &got) != nil || got != receipt {
			t.Fatal("release lost its exact original identity", confirmed)
		}
		return nil
	})
	upload.StorageReleased = true
	_, err = db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	assertRelease(false)
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload)
	})
	assertRelease(true)
}

func testPendingMediaOffersRejectCorruptCandidateWithoutPartialResults(t *testing.T, db *postgres.Store) {
	sessionID, _ := prepareImageSession(t, db)
	ctx := t.Context()
	current := sp.Fence{SessionID: sessionID, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}
	validID := "00000000-0000-4000-8000-000000000001"
	corruptID := "00000000-0000-4000-8000-000000000002"
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		for _, id := range []string{validID, corruptID} {
			if err := base.(store.SessionMediaDAO).SaveSessionMediaRequest(ctx, store.SessionMediaRequest{
				SessionID: sessionID, RequestID: id, Action: "prepare",
				Fence: sp.ControllerFence{Fence: current, ConnectionEpoch: "1"}, Body: []byte(`{}`),
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if _, err := db.Pool.Exec(ctx, `UPDATE session_media_requests SET error='{"code":3}'::jsonb WHERE session_id=$1 AND request_id=$2`, sessionID, corruptID); err != nil {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		pending, err := base.(store.SessionMediaDAO).PendingSessionMediaRequests(ctx, current)
		var decodeError *json.UnmarshalTypeError
		if !errors.As(err, &decodeError) {
			t.Fatal("corrupt candidate lost its persisted metadata decoding error", err)
		}
		if len(pending) != 0 {
			t.Fatal("corrupt candidate allowed a partial media offer", pending)
		}
		return nil
	})
	var pending, unchanged bool
	if err := db.Pool.QueryRow(ctx, `SELECT NOT complete,error='{"code":3}'::jsonb FROM session_media_requests WHERE session_id=$1 AND request_id=$2`, sessionID, corruptID).Scan(&pending, &unchanged); err != nil {
		t.Fatal(err)
	}
	if !pending || !unchanged {
		t.Fatal("failed offer selection changed the corrupt pending request", pending, unchanged)
	}
}

func testPendingMediaOffersFilterCurrentFenceBeforeLimitAndRetainOriginalRows(t *testing.T, db *postgres.Store, kind string) {
	sessionID, _ := prepareImageSession(t, db)
	current := sp.Fence{SessionID: sessionID, ExecutionGeneration: "2"}
	if kind == "task" {
		current.ClaimID = uuid.NewString()
	} else {
		current.TestExecutionID = uuid.NewString()
	}
	rows := make([]store.SessionMediaRequest, 7)
	for i := range rows {
		rows[i] = store.SessionMediaRequest{SessionID: sessionID, RequestID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1), Action: "prepare", Fence: sp.ControllerFence{Fence: current, ConnectionEpoch: "1"}, Body: []byte(`{}`)}
	}
	rows[0].Fence.ExecutionGeneration = "1"
	rows[1].Fence.ExecutionGeneration = "1"
	if kind == "task" {
		rows[2].Fence.ClaimID = uuid.NewString()
		rows[3].Fence.TestExecutionID = uuid.NewString()
	} else {
		rows[2].Fence.TestExecutionID = uuid.NewString()
		rows[3].Fence.ClaimID = uuid.NewString()
	}
	rows[5].Fence.ConnectionEpoch = "2"
	rows[6].Fence.ConnectionEpoch = "3"
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		media := base.(store.SessionMediaDAO)
		for _, row := range rows {
			if err := media.SaveSessionMediaRequest(t.Context(), row); err != nil {
				return err
			}
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		media := base.(store.SessionMediaDAO)
		pending, err := media.PendingSessionMediaRequests(t.Context(), current)
		if err != nil {
			return err
		}
		if len(pending) != 2 || pending[0].RequestID != rows[4].RequestID || pending[1].RequestID != rows[5].RequestID {
			t.Fatalf("current media requests were starved by stale fences before the offer limit: %+v", pending)
		}
		if pending[0].Fence.ConnectionEpoch != "1" || pending[1].Fence.ConnectionEpoch != "2" {
			t.Fatal("same-generation reconnect candidates lost their original connection epochs", pending)
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		for _, original := range rows {
			loaded, err := base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), sessionID, original.RequestID)
			if err != nil {
				return err
			}
			if loaded.Fence != original.Fence || loaded.Complete || loaded.Error != nil || loaded.Result != nil || !bytes.Equal(loaded.Body, original.Body) {
				t.Fatal("offer selection changed an original unknown request", loaded)
			}
		}
		return nil
	})
}

func testMediaPayloadRepresentationRewriteUsesExactObservedState(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	upload, resource := uuid.NewString(), uuid.NewString()
	row := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "write", Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Body: []byte(`{"uploadId":"` + upload + `","data":"b3JpZ2luYWw=","offset":"0","sha256":"digest"}`)}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row)
	})
	var observed store.SessionMediaRequest
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		var err error
		observed, err = base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), id, row.RequestID)
		return err
	})
	rewritten := observed
	rewritten.Expected = &store.SessionMediaState{Fence: observed.Fence, Body: observed.Body, Result: observed.Result, Error: observed.Error, Complete: observed.Complete}
	rewritten.Body = []byte(`{"uploadId":"` + upload + `","offset":"0","sha256":"digest","$data":{"sha256":"digest","byteLength":8}}`)
	rollback := errors.New("rollback compact representation")
	_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), rewritten); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		got, err := base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), id, row.RequestID)
		if err == nil && !bytes.Contains(got.Body, []byte(`"data"`)) {
			t.Fatal("rollback published compact body")
		}
		return err
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), rewritten)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		got, err := d.SessionMediaRequest(t.Context(), id, row.RequestID)
		if err != nil {
			return err
		}
		if bytes.Contains(got.Body, []byte(`"data"`)) || got.Complete || got.Expected != nil {
			t.Fatal("payload rewrite did not persist only the intended state", string(got.Body))
		}
		// Replaying the same rewrite is stale: the old full-body representation
		// no longer exists, even though its request identity is unchanged.
		err = d.SaveSessionMediaRequest(t.Context(), rewritten)
		var conflict *model.Fault
		if !errors.As(err, &conflict) || conflict.Code != "resource_conflict" {
			t.Fatal("stale observed CAS succeeded", err)
		}
		return nil
	})
	// The optional query includes exact upload, capture/preparation and resource
	// owners and excludes unrelated rows in the same Session.
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		for _, body := range []string{`{"attemptId":"` + upload + `"}`, `{"preparationId":"` + upload + `"}`, `{"resourceId":"` + resource + `"}`, `{"uploadId":"` + uuid.NewString() + `"}`} {
			next := row
			next.RequestID = uuid.NewString()
			next.Action = "read_capture"
			next.Body = []byte(body)
			if err := d.SaveSessionMediaRequest(t.Context(), next); err != nil {
				return err
			}
		}
		rows, err := base.(store.SessionUploadMediaDAO).SessionUploadMediaRequests(t.Context(), id, upload, resource)
		if err == nil && len(rows) != 4 {
			t.Fatal("upload media query crossed identity boundaries", len(rows))
		}
		return err
	})
}

func testCompletedReadPayloadRewritePersistsBoundedReceiptAndRejectsChangedResult(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	row := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "read_capture", Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Body: []byte(`{"attemptId":"` + uuid.NewString() + `"}`), Complete: true, Result: []byte(`{"data":"b3JpZ2luYWw=","offset":"0"}`)}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row)
	})
	var compact store.SessionMediaRequest
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		got, err := d.SessionMediaRequest(t.Context(), id, row.RequestID)
		if err != nil {
			return err
		}
		compact = got
		compact.Expected = &store.SessionMediaState{Fence: got.Fence, Body: got.Body, Result: got.Result, Complete: true}
		compact.Result = []byte(`{"$data":{"sha256":"digest","byteLength":8},"offset":"0"}`)
		return d.SaveSessionMediaRequest(t.Context(), compact)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionMediaDAO)
		got, err := d.SessionMediaRequest(t.Context(), id, row.RequestID)
		if err != nil {
			return err
		}
		if bytes.Contains(got.Result, []byte(`"data"`)) || !got.Complete || len(got.Result) > 128 {
			t.Fatal("completed receipt retained original bytes")
		}
		compact.Expected = &store.SessionMediaState{Fence: got.Fence, Body: got.Body, Result: got.Result, Error: got.Error, Complete: got.Complete}
		got.Result = []byte(`{"different":"receipt"}`)
		if err = d.SaveSessionMediaRequest(t.Context(), got); err == nil {
			t.Fatal("completed receipt was mutable without observed CAS")
		}
		return nil
	})
	// A stale body, result, error, completion or connection epoch must each fail.
	for _, field := range []string{"body", "result", "error", "complete", "epoch"} {
		t.Run(field, func(t *testing.T) {
			changed := compact
			expected := *compact.Expected
			changed.Expected = &expected
			switch field {
			case "body":
				expected.Body = []byte(`{}`)
			case "result":
				expected.Result = []byte(`{}`)
			case "error":
				expected.Error = &sp.ImageError{Code: "changed", Message: "changed"}
			case "complete":
				expected.Complete = false
			case "epoch":
				expected.Fence.ConnectionEpoch = "2"
			}
			_, err := db.WriteSession(context.Background(), func(scope store.SessionScope) error {
				return scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), changed)
			})
			var conflict *model.Fault
			if !errors.As(err, &conflict) || conflict.Code != "resource_conflict" {
				t.Fatal("changed observed field was accepted", field, err)
			}
		})
	}
}

func testUnpublishedUploadMediaLeaseUsesWildcardUntilResourceExists(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), ByteLength: "8"}, Receipt: sp.ImageUploadReceipt{State: "verifying", AcceptedOffset: "8"}, ExpiresAt: time.Now().Add(time.Hour)}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		if _, err := d.SessionResourceUsage(t.Context(), id); err != nil {
			return err
		}
		return d.SaveSessionUpload(t.Context(), upload)
	})
	lease := store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: id, ID: uuid.NewString(), OwnerID: actor.UserID, Kind: "read"}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), lease)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		rows, err := d.ListSessionResourceLeases(t.Context(), id)
		if err != nil {
			return err
		}
		if len(rows) != 1 || rows[0].ID != lease.ID || rows[0].ResourceID != "" {
			t.Fatal("unpublished media owner did not persist wildcard lease", rows)
		}
		if _, err = d.SavedSessionResource(t.Context(), id, upload.BlobID); !errors.Is(err, model.ErrNotFound) {
			t.Fatal("pending upload unexpectedly required a published resource", err)
		}
		return nil
	})
	// This is the DAO lookup that an unpublished-blob-specific lease would hit.
	bad := lease
	bad.ID = uuid.NewString()
	bad.ResourceID = upload.BlobID
	_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), bad)
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("fixture did not exercise the missing resource lookup", err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionResourceDAO).ReleaseSessionResourceLease(t.Context(), id, lease.ID)
	})
}

func testMediaPayloadRewriteAndInventoryPreserveClosedTransactionErrors(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	row := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "write", Body: []byte(`{}`)}
	for _, rewrite := range []bool{false, true} {
		if rewrite {
			row.Expected = &store.SessionMediaState{Body: row.Body}
		}
		if err = dao.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), row); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatal("save hid closed transaction cause", rewrite, err)
		}
	}
	if rows, err := dao.(store.SessionUploadMediaDAO).SessionUploadMediaRequests(t.Context(), id, uuid.NewString(), uuid.NewString()); !errors.Is(err, pgx.ErrTxClosed) || rows != nil {
		t.Fatal("failed inventory supplied results or hid its cause", rows, err)
	}
}

func testUnsettledResourceBarrierPreservesUnknownEffectsWithoutBlockingReadOnlyControls(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	seq := int64(0)
	for _, kind := range []string{"refresh_controls", "update_setting", "send_message", "interaction_response", "execute_command", "cancel"} {
		for _, state := range []string{"accepted", "offered", "dispatching", "unknown"} {
			t.Run(kind+"/"+state, func(t *testing.T) {
				seq++
				op := uuid.NewString()
				sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
					return d.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: op, Seq: seq, Actor: actor, Hash: []byte("original"), Command: sp.Command{Kind: kind, Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{SessionID: id, OperationID: op, State: state}})
				})
				sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
					n, e := d.(store.SessionResourceDAO).UnsettledSessionResourceWrites(t.Context(), id)
					want := 1
					if kind == "refresh_controls" || kind == "update_setting" {
						want = 0
					}
					if e != nil || n != want {
						t.Fatalf("unsettled=%d want=%d: %v", n, want, e)
					}
					saved, e := d.SessionOperation(t.Context(), id, op)
					if e != nil || saved.Receipt.State != state {
						t.Fatalf("barrier changed receipt: %+v %v", saved.Receipt, e)
					}
					return d.SetSessionOperationReceipt(t.Context(), sp.Operation{SessionID: id, OperationID: op, State: "confirmed"})
				})
			})
		}
	}
	resource, op := uuid.NewString(), uuid.NewString()
	seq++
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		r := d.(store.SessionResourceDAO)
		if e := r.InsertSessionResource(t.Context(), store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resource, Status: "pending", Name: "original.png"}}); e != nil {
			return e
		}
		if e := d.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: op, Seq: seq, Actor: actor, Hash: []byte("pinned"), Command: sp.Command{Kind: "refresh_controls", Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{State: "unknown"}}); e != nil {
			return e
		}
		return r.AddSessionResourceReference(t.Context(), store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "operation", ReferenceID: op})
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		n, e := d.(store.SessionResourceDAO).UnsettledSessionResourceWrites(t.Context(), id)
		if e == nil && n != 1 {
			t.Fatalf("unknown pinned operation bypassed closure: %d", n)
		}
		return e
	})
}
