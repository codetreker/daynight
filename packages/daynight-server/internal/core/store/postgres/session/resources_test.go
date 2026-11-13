package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
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

func TestSessionImageStore(t *testing.T) {
	suite := newSessionStoreSuite(t)
	suite.run(t, "DirectFirstIdentityAndChunkIntentCommitTogether", testDirectFirstIdentityAndChunkIntentCommitTogether)
	suite.run(t, "ExternalCaptureWritesCompareExactObservedState", testExternalCaptureWritesCompareExactObservedState)
	suite.run(t, "FailedCaptureIdentityPersistsAndRollsBack", testFailedCaptureIdentityPersistsAndRollsBack)
	suite.run(t, "FailedPreparationAndOriginalReleasePersistIndependentlyOfQuotaSettlement", testFailedPreparationAndOriginalReleasePersistIndependentlyOfQuotaSettlement)
	suite.run(t, "ExternalSourceHashPrunesExplicitBoundaryAndOldEpoch", testExternalSourceHashPrunesExplicitBoundaryAndOldEpoch)
	suite.run(t, "ExternalResourceVolumeIncludesTemporaryHistoryAndTimelineCopies", testExternalResourceVolumeIncludesTemporaryHistoryAndTimelineCopies)
	suite.run(t, "PendingMediaOffersRejectCorruptCandidateWithoutPartialResults", testPendingMediaOffersRejectCorruptCandidateWithoutPartialResults)
	suite.run(t, "PendingMediaOffersFilterCurrentFenceBeforeLimitAndRetainOriginalRows/task", func(t *testing.T, db *postgres.Store) {
		testPendingMediaOffersFilterCurrentFenceBeforeLimitAndRetainOriginalRows(t, db, "task")
	})
	suite.run(t, "PendingMediaOffersFilterCurrentFenceBeforeLimitAndRetainOriginalRows/test_execution", func(t *testing.T, db *postgres.Store) {
		testPendingMediaOffersFilterCurrentFenceBeforeLimitAndRetainOriginalRows(t, db, "test execution")
	})
	suite.run(t, "MediaPayloadRepresentationRewriteUsesExactObservedState", testMediaPayloadRepresentationRewriteUsesExactObservedState)
	suite.run(t, "CompletedReadPayloadRewritePersistsBoundedReceiptAndRejectsChangedResult", testCompletedReadPayloadRewritePersistsBoundedReceiptAndRejectsChangedResult)
	suite.run(t, "UnpublishedUploadMediaLeaseUsesWildcardUntilResourceExists", testUnpublishedUploadMediaLeaseUsesWildcardUntilResourceExists)
	suite.run(t, "MediaPayloadRewriteAndInventoryPreserveClosedTransactionErrors", testMediaPayloadRewriteAndInventoryPreserveClosedTransactionErrors)
	suite.run(t, "MediaRateStatePersistsIndependentOwnersAndCategories", testMediaRateStatePersistsIndependentOwnersAndCategories)
	suite.run(t, "ResourceInventoryOrdersAndScopesCompleteRecords", testResourceInventoryOrdersAndScopesCompleteRecords)
	suite.run(t, "ResourceLedgerReadsPresenceAndRetainsImmutableWriteConflicts", testResourceLedgerReadsPresenceAndRetainsImmutableWriteConflicts)
	suite.run(t, "ResourceDAOClosedTransactionsPreserveErrorsWithoutSuccessfulResults", testResourceDAOClosedTransactionsPreserveErrorsWithoutSuccessfulResults)
	suite.run(t, "MediaRequestReadRejectsCorruptPersistedTypedMetadata", testMediaRequestReadRejectsCorruptPersistedTypedMetadata)
	suite.run(t, "ResourceCancelledObservationDoesNotCreateState", testResourceCancelledObservationDoesNotCreateState)
	suite.run(t, "UnsettledResourceBarrierPreservesUnknownEffectsWithoutBlockingReadOnlyControls", testUnsettledResourceBarrierPreservesUnknownEffectsWithoutBlockingReadOnlyControls)
	suite.run(t, "UploadSettlementRejectsCorruptPersistedJSONWithoutPartialInventory/spec", func(t *testing.T, db *postgres.Store) {
		testUploadSettlementRejectsCorruptPersistedJSONWithoutPartialInventory(t, db, "spec")
	})
	suite.run(t, "UploadSettlementRejectsCorruptPersistedJSONWithoutPartialInventory/receipt", func(t *testing.T, db *postgres.Store) {
		testUploadSettlementRejectsCorruptPersistedJSONWithoutPartialInventory(t, db, "receipt")
	})
	suite.run(t, "UploadSettlementPreservesClosedTransactionAndCancellationErrors", testUploadSettlementPreservesClosedTransactionAndCancellationErrors)
	suite.run(t, "ResourceReclamationPersistsAdmissionBarrierUntilFinalDeletion", testResourceReclamationPersistsAdmissionBarrierUntilFinalDeletion)
	suite.run(t, "UploadSettlementSelectsFixedExpiryAndUnconfirmedCleanup", testUploadSettlementSelectsFixedExpiryAndUnconfirmedCleanup)
	suite.run(t, "SavedResourceVisibilityRequiresActorOrPublishedReference", testSavedResourceVisibilityRequiresActorOrPublishedReference)
	suite.run(t, "ExternalResourceLedgerPersistsIdentityBudgetPinsAndDeletion", testExternalResourceLedgerPersistsIdentityBudgetPinsAndDeletion)
	suite.run(t, "ExternalMediaLedgerReconnectCaptureAndAdmission", testExternalMediaLedgerReconnectCaptureAndAdmission)
}

func testDirectFirstIdentityAndChunkIntentCommitTogether(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	id, actor := prepareImageSession(t, db)
	uploadID, imageID, blobID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	expires := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	fence := sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}
	spec := sp.ImageUploadSpec{UploadID: uploadID, ImageID: imageID, Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: actor.UserID, Fence: fence}, Name: "original.png", MediaType: "image/png", ByteLength: "16", SHA256: archiveHashOf("original-original")}
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: blobID, Spec: spec, ExpiresAt: expires, Receipt: sp.ImageUploadReceipt{UploadID: uploadID, ImageID: imageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0", Spec: sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}, ExpiresAt: expires.Format(time.RFC3339Nano)}}
	intent := store.SessionUploadChunk{SessionID: id, UploadID: uploadID, Offset: 0, ByteLength: 8, SHA256: archiveHashOf("original"), Path: "original/first-chunk"}
	rollbackError := errors.New("reject first identity and chunk intent")
	write := func(rollback bool) (store.Completion, error) {
		return db.WriteSession(ctx, func(scope store.SessionScope) error {
			base := scope.SessionDAO()
			if _, err := base.LockSession(ctx, id); err != nil {
				return err
			}
			dao := base.(store.SessionResourceDAO)
			if err := dao.SaveSessionUpload(ctx, upload); err != nil {
				return err
			}
			if err := dao.InsertSessionUploadChunk(ctx, intent); err != nil {
				return err
			}
			if rollback {
				return rollbackError
			}
			return nil
		})
	}
	completion, err := write(true)
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, rollbackError) {
		t.Fatalf("identity and first intent rollback: %+v %v", completion, err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionResourceDAO)
		if _, err := dao.SessionUpload(ctx, id, uploadID); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("rolled back upload identity is visible: %v", err)
		}
		chunks, err := dao.SessionUploadChunks(ctx, id, uploadID)
		if err != nil || len(chunks) != 0 {
			t.Fatalf("rolled back chunk intent is visible: %+v %v", chunks, err)
		}
		return nil
	})
	completion, err = write(false)
	if completion.Outcome != store.TransactionCommitted || err != nil {
		t.Fatalf("identity and first intent commit: %+v %v", completion, err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionResourceDAO)
		got, err := dao.SessionUpload(ctx, id, uploadID)
		if err != nil {
			return err
		}
		if !got.ExpiresAt.Equal(expires) {
			t.Fatalf("upload expiry changed: %+v", got)
		}
		got.ExpiresAt = expires
		if !reflect.DeepEqual(got, upload) || got.Receipt.AcceptedOffset != "0" {
			t.Fatalf("first intent changed identity or confirmed bytes: got=%+v want=%+v", got, upload)
		}
		chunks, err := dao.SessionUploadChunks(ctx, id, uploadID)
		if err != nil || len(chunks) != 1 || chunks[0] != intent {
			t.Fatalf("first intent readback differs: got=%+v want=%+v error=%v", chunks, intent, err)
		}
		return nil
	})
}

func testFailedCaptureIdentityPersistsAndRollsBack(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: uuid.NewString()}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	row := store.SessionCaptureRecord{SessionID: id, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: request.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "failed", Error: &sp.ImageError{Code: "quota_exceeded", Message: "Capacity exhausted."}}}
	rejected := errors.New("rollback failure receipt")
	completion, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(t.Context(), row); err != nil {
			return err
		}
		return rejected
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, rejected) {
		t.Fatalf("failed receipt rollback: %+v %v", completion, err)
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		_, err := d.(store.SessionResourceDAO).SessionCapture(t.Context(), id, request.CaptureID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("rolled back receipt was visible: %v", err)
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).SaveSessionCapture(t.Context(), row)
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		got, err := d.(store.SessionResourceDAO).SessionCapture(t.Context(), id, request.CaptureID)
		if err == nil && !reflect.DeepEqual(got, row) {
			t.Fatalf("failed receipt changed on readback: got=%+v want=%+v", got, row)
		}
		return err
	})
}

func testExternalCaptureWritesCompareExactObservedState(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: uuid.NewString()}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	resource := uuid.NewString()
	initial := store.SessionCaptureRecord{SessionID: id, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: uuid.NewString(), Revision: "3", Occurrence: request.Occurrence, State: "reserved", ResourceID: &resource}}
	// These are explicit persisted facts from a completed original staging release
	// and a later reservation, without executing the core retry decision here.
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: request.AttemptID, ImageID: request.Occurrence.ImageID, ByteLength: "10"}, ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour), Receipt: sp.ImageUploadReceipt{State: "failed"}, StorageReleased: true})
	})
	save := func(row store.SessionCaptureRecord) error {
		_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(t.Context(), row)
		})
		return err
	}
	read := func(want store.SessionCaptureRecord) {
		t.Helper()
		want.Expected = nil
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			loaded, err := d.(store.SessionResourceDAO).SessionCaptureByImage(t.Context(), id, request.Occurrence.ImageID)
			if err == nil && !reflect.DeepEqual(loaded, want) {
				t.Fatalf("capture persisted a different request, receipt, validation or precondition: got=%+v want=%+v", loaded, want)
			}
			return err
		})
	}
	refused := func(row store.SessionCaptureRecord) {
		t.Helper()
		var refusal *model.Fault
		if err := save(row); !errors.As(err, &refusal) || refusal.Code != "resource_conflict" {
			t.Fatalf("capture write did not expose a conflicting precondition: %v", err)
		}
	}
	if err := save(initial); err != nil {
		t.Fatal(err)
	}
	read(initial)
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		usage, err := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		if err == nil && (usage.Bytes != 0 || usage.Resources != 0) {
			t.Fatal("uncommitted capture counted as available content", usage)
		}
		return err
	})
	refused(initial)
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "10", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Width: 2, Height: 3, FrameCount: 1}
	copying := initial
	copying.Expected = &store.SessionCaptureState{Receipt: initial.Receipt}
	copying.Receipt.State, copying.Receipt.Revision, copying.Validated = "copying", "4", &validated
	if err := save(copying); err != nil {
		t.Fatal("NULL validation precondition did not match", err)
	}
	read(copying)
	refused(copying)
	read(copying)
	committed := copying
	committed.Expected = &store.SessionCaptureState{Receipt: copying.Receipt, Validated: &validated}
	committed.Receipt.State, committed.Receipt.Revision = "committed", "5"
	committed.Receipt.Resource = &sp.Resource{Revision: "1", ResourceID: resource, Status: "available"}
	for _, kind := range []string{"request", "receipt", "validation", "missing"} {
		t.Run(kind, func(t *testing.T) {
			changed := committed
			expected := *committed.Expected
			changed.Expected = &expected
			switch kind {
			case "request":
				changed.Request.Locator.URL = "https://replacement.example/image.png"
			case "receipt":
				changed.Expected.Receipt.Revision = "1"
			case "validation":
				other := validated
				other.Width++
				changed.Expected.Validated = &other
			case "missing":
				changed.Request.CaptureID = uuid.NewString()
			}
			refused(changed)
			read(copying)
		})
	}
	rejected := errors.New("reject capture transaction")
	completion, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(t.Context(), committed); err != nil {
			return err
		}
		return rejected
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, rejected) {
		t.Fatal("capture rollback lost its outcome or cause", completion, err)
	}
	read(copying)
	if err := save(committed); err != nil {
		t.Fatal("exact receipt and validation precondition did not match", err)
	}
	read(committed)
	for _, identity := range []string{"source", "image", "attempt"} {
		t.Run("unique "+identity, func(t *testing.T) {
			duplicate := initial
			duplicate.Request.CaptureID = uuid.NewString()
			duplicate.Request.Occurrence.ImageID = uuid.NewString()
			duplicate.Request.Occurrence.SourceKey = uuid.NewString()
			duplicate.Request.AttemptID = uuid.NewString()
			switch identity {
			case "source":
				duplicate.Request.Occurrence.SourceKey = request.Occurrence.SourceKey
			case "image":
				duplicate.Request.Occurrence.ImageID = request.Occurrence.ImageID
			case "attempt":
				duplicate.Request.AttemptID = initial.Receipt.AttemptID
			}
			duplicate.Receipt.CaptureID, duplicate.Receipt.AttemptID, duplicate.Receipt.Occurrence = duplicate.Request.CaptureID, duplicate.Request.AttemptID, duplicate.Request.Occurrence
			refused(duplicate)
			completion, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
				dao := scope.SessionDAO().(store.SessionResourceDAO)
				var fault *model.Fault
				if err := dao.SaveSessionCapture(t.Context(), duplicate); !errors.As(err, &fault) || fault.Code != "resource_conflict" {
					t.Fatalf("expected identity conflict, got %v", err)
				}
				_, err := dao.SessionCapture(t.Context(), id, initial.Request.CaptureID)
				return err
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("identity refusal aborted the transaction: %+v %v", completion, err)
			}
			read(committed)
		})
	}
}

func testExternalResourceVolumeIncludesTemporaryHistoryAndTimelineCopies(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionArchiveDAO).SaveSessionArchiveBundle(t.Context(), store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "active", Revision: 1, Identity: []byte(`{}`), Resources: []byte(`[]`), Ledger: []byte(`{}`)})
	})
	var baseline store.SessionResourceUsage
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		u, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
		baseline = u
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
		if e == nil && (u != baseline) {
			t.Fatal("temporary archive copies changed accepted resource usage", u, baseline)
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
		if e == nil && u != baseline {
			t.Fatal("released metadata changed accepted resource usage", u, baseline)
		}
		return e
	})
}

func testResourceInventoryOrdersAndScopesCompleteRecords(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	projectID := queryID(1)
	task := queryTask(t, db, projectID, 3, model.TaskInProgress)
	other := uuid.NewString()
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: other, ProjectID: projectID, TaskID: task.ID}, ClaimID: uuid.NewString(), OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "active"}})
	})
	ids := []string{"00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"}
	media, size, hash := "image/png", "8", archiveHashOf("original")
	for _, resourceID := range ids {
		resource := sp.Resource{ResourceID: resourceID, Status: "available", Name: resourceID, MediaType: &media, ByteLength: &size, SHA256: &hash}
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			return base.(store.SessionResourceDAO).InsertSessionResource(t.Context(), store.SessionResourceRecord{SessionID: id, Resource: resource, BlobID: resourceID, BlobPath: "original/" + resourceID})
		})
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionResourceDAO).InsertSessionResource(t.Context(), store.SessionResourceRecord{SessionID: other, Resource: sp.Resource{ResourceID: uuid.NewString(), Status: "pending", Name: "other"}})
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		resources := base.(store.SessionResourceDAO)
		rows, err := resources.ListSessionResources(t.Context(), id)
		if err != nil {
			return err
		}
		if len(rows) != 2 || rows[0].Resource.ResourceID != ids[1] || rows[1].Resource.ResourceID != ids[0] {
			t.Fatal("inventory order or scope changed", rows)
		}
		for _, row := range rows {
			individual, err := resources.SavedSessionResource(t.Context(), id, row.Resource.ResourceID)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(row, individual) {
				t.Fatal("batch lost resource facts", row, individual)
			}
		}
		return nil
	})
}

func testResourceLedgerReadsPresenceAndRetainsImmutableWriteConflicts(t *testing.T, db *postgres.Store) {
	id, actor := prepareImageSession(t, db)
	ctx := t.Context()
	resource := uuid.NewString()
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: resource, Spec: sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Name: "original.png", MediaType: "image/png", ByteLength: "8", SHA256: archiveHashOf("original")}, ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour), Receipt: sp.ImageUploadReceipt{State: "receiving", AcceptedOffset: "0"}}
	ref := store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "message", ReferenceID: "original-message"}
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}
	media := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewString(), Action: "read", Fence: fence, Body: []byte(`{}`), Complete: true, Error: &sp.ImageError{Code: "source_unavailable", Message: "Original source unavailable."}}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		found, e := d.SessionResourceReferenceExists(ctx, ref)
		if e != nil || found {
			t.Fatal("absent pin returned present", found, e)
		}
		found, e = d.SessionImageUploadExists(ctx, id, upload.Spec.ImageID)
		if e != nil || found {
			t.Fatal("absent image returned present", found, e)
		}
		if e = d.SaveSessionUpload(ctx, upload); e != nil {
			return e
		}
		if e = d.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resource, Status: "pending", Name: "original.png"}}); e != nil {
			return e
		}
		if e = d.AddSessionResourceReference(ctx, ref); e != nil {
			return e
		}
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(ctx, media)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		found, e := d.SessionResourceReferenceExists(ctx, ref)
		if e != nil || !found {
			t.Fatal("committed pin missing", found, e)
		}
		found, e = d.SessionImageUploadExists(ctx, id, upload.Spec.ImageID)
		if e != nil || !found {
			t.Fatal("committed image missing", found, e)
		}
		changed := upload
		changed.Spec.Name = "replacement.png"
		if e = d.SaveSessionUpload(ctx, changed); e == nil {
			t.Fatal("immutable upload accepted changed original")
		} else {
			var fault *model.Fault
			if !errors.As(e, &fault) || fault.Code != "resource_conflict" {
				return e
			}
		}
		changedMedia := media
		changedMedia.Action = "release"
		if e = base.(store.SessionMediaDAO).SaveSessionMediaRequest(ctx, changedMedia); e == nil {
			t.Fatal("immutable media accepted changed action")
		} else {
			var fault *model.Fault
			if !errors.As(e, &fault) || fault.Code != "resource_conflict" {
				return e
			}
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		u, e := base.(store.SessionResourceDAO).SessionUpload(ctx, id, upload.Spec.UploadID)
		if e != nil {
			return e
		}
		if u.Spec != upload.Spec {
			t.Fatal("rejected replacement changed committed original", u)
		}
		m, e := base.(store.SessionMediaDAO).SessionMediaRequest(ctx, id, media.RequestID)
		if e != nil {
			return e
		}
		if m.Action != media.Action || !m.Complete || m.Error == nil || *m.Error != *media.Error {
			t.Fatal("terminal remote failure did not survive committed readback", m)
		}
		return nil
	})
}

func testResourceDAOClosedTransactionsPreserveErrorsWithoutSuccessfulResults(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	tx, e := db.Pool.Begin(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	if e = tx.Rollback(t.Context()); e != nil {
		t.Fatal(e)
	}
	base := pgsession.New(tx)
	resources := base.(store.SessionResourceDAO)
	media := base.(store.SessionMediaDAO)
	checks := []struct {
		name string
		read func() error
	}{
		{"resources", func() error {
			rows, e := resources.ListSessionResources(t.Context(), id)
			if len(rows) != 0 {
				t.Fatal("closed transaction supplied inventory")
			}
			return e
		}},
		{"pending media", func() error {
			rows, e := media.PendingSessionMediaRequests(t.Context(), sp.Fence{SessionID: id})
			if len(rows) != 0 {
				t.Fatal("closed transaction supplied pending media")
			}
			return e
		}},
		{"usage", func() error { _, e := resources.SessionResourceUsage(t.Context(), id); return e }},
		{"upload save", func() error {
			return resources.SaveSessionUpload(t.Context(), store.SessionUploadRecord{SessionID: id})
		}},
		{"media save", func() error {
			return media.SaveSessionMediaRequest(t.Context(), store.SessionMediaRequest{SessionID: id})
		}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if e := check.read(); !errors.Is(e, pgx.ErrTxClosed) {
				t.Fatal("closed transaction result lost its cause", e)
			}
		})
	}
}

func testMediaRequestReadRejectsCorruptPersistedTypedMetadata(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	ctx := t.Context()
	request := uuid.NewString()
	for _, kind := range []string{"fence", "error"} {
		t.Run(kind, func(t *testing.T) {
			fence, errorBody := `{"sessionId":"`+id+`","claimId":"`+uuid.NewString()+`","executionGeneration":"1","connectionEpoch":"1"}`, `{"code":"source_unavailable","message":"Original source unavailable."}`
			if kind == "fence" {
				fence = `{"connectionEpoch":2}`
			} else {
				errorBody = `{"code":3}`
			}
			if _, e := db.Pool.Exec(ctx, `INSERT INTO session_media_requests(session_id,request_id,action,fence,body,error,complete) VALUES($1,$2,'read',$3,'{}',$4,true) ON CONFLICT(session_id,request_id) DO UPDATE SET fence=EXCLUDED.fence,error=EXCLUDED.error`, id, request, fence, errorBody); e != nil {
				t.Fatal(e)
			}
			sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
				if _, e := base.(store.SessionMediaDAO).SessionMediaRequest(ctx, id, request); e == nil {
					t.Fatal("corrupt persisted typed metadata became valid")
				}
				return nil
			})
		})
	}
}

func testResourceCancelledObservationDoesNotCreateState(t *testing.T, db *postgres.Store) {
	_, _ = prepareImageSession(t, db)
	missing := uuid.NewString()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	tx, e := db.Pool.Begin(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	defer rollbackSessionTestTransaction(t, tx)
	if _, e = pgsession.New(tx).(store.SessionResourceDAO).SessionResourceUsage(ctx, missing); !errors.Is(e, context.Canceled) {
		t.Fatal("cancelled admission was reported successful", e)
	}
	var count int
	if e = db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM session_resource_state WHERE session_id=$1`, missing).Scan(&count); e != nil || count != 0 {
		t.Fatal("cancelled observation allocated resource state", count, e)
	}
}

func testExternalResourceLedgerPersistsIdentityBudgetPinsAndDeletion(t *testing.T, db *postgres.Store) {
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
		if u.Bytes != 0 || u.Resources != 0 {
			t.Fatalf("uncommitted upload counted as content %+v", u)
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
		if u.Bytes != 10485760 || u.Resources != 1 {
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

func testExternalMediaLedgerReconnectCaptureAndAdmission(t *testing.T, db *postgres.Store) {
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
		pending, e := m.PendingSessionMediaRequests(t.Context(), fence.Fence)
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
		pending, e := m.PendingSessionMediaRequests(t.Context(), fence.Fence)
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
		if usage.Bytes != 0 || usage.Resources != 0 {
			t.Fatal("uncommitted capture counted as content", usage)
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
