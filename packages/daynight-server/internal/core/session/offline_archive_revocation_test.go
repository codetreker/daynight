package session

import (
	"encoding/json"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestOfflineSuccessorRevocationPreservesReceiptAndValidatesContinuations(t *testing.T) {
	previous := store.ArchiveBundleFile{SessionID: "session", FileID: "old", State: "failed", UploadVersion: 2, Purpose: "history", SHA256: "hash", ByteLength: 7, TimelineRevision: 2, Resource: json.RawMessage(`null`), SuccessorFileID: "11111111-1111-4111-8111-111111111111", TerminalError: json.RawMessage(`{"code":"staging_corrupt","message":"corrupt"}`)}
	next := previous
	next.FileID, next.State, next.SuccessorFileID, next.TerminalError = "11111111-1111-4111-8111-111111111111", "receiving", "", nil
	state := store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{{File: next, Predecessors: []store.ArchiveBundleFile{previous}}}}
	plan, err := PlanOfflineArchiveRevocations(state)
	if err != nil || len(plan) != 1 {
		t.Fatal(plan, err)
	}
	failed := store.StorageArchiveFileV2{UploadVersion: 2, FileID: previous.FileID, Purpose: previous.Purpose, SHA256: previous.SHA256, ByteLength: 7, TimelineRevision: 2, Resource: previous.Resource, State: "failed", SuccessorFileID: "11111111-1111-4111-8111-111111111111", TerminalError: plan[0].TerminalError}
	var receiptError sp.ImageError
	if err := json.Unmarshal(failed.TerminalError, &receiptError); err != nil || receiptError.Code != "staging_corrupt" || receiptError.Message != "corrupt" {
		t.Fatal(receiptError, err)
	}
	if err := verifyArchiveSuccessors("session", failed, map[string]store.StorageArchiveFileV2{}); err != nil {
		t.Fatal(err)
	}
	continued := failed
	continued.FileID, continued.State, continued.SuccessorFileID, continued.TerminalError = "11111111-1111-4111-8111-111111111111", "complete", "", nil
	if err := verifyArchiveSuccessors("session", failed, map[string]store.StorageArchiveFileV2{"11111111-1111-4111-8111-111111111111": continued}); err != nil {
		t.Fatal(err)
	}
	continued.ByteLength++
	if err := verifyArchiveSuccessors("session", failed, map[string]store.StorageArchiveFileV2{"11111111-1111-4111-8111-111111111111": continued}); err == nil {
		t.Fatal("mismatched present successor accepted")
	}
	failed.TerminalError = previous.TerminalError
	if err := verifyArchiveSuccessors("session", failed, map[string]store.StorageArchiveFileV2{}); err == nil {
		t.Fatal("unproven missing successor accepted")
	}
	failed.TerminalError = plan[0].TerminalError
	registration := store.ArchiveStagingRecord{SessionID: next.SessionID, FileID: next.FileID, Purpose: next.Purpose, SHA256: next.SHA256, ByteLength: next.ByteLength, TimelineRevision: next.TimelineRevision, Resource: next.Resource, State: "receiving"}
	predecessor := registration
	predecessor.FileID, predecessor.State, predecessor.SuccessorFileID, predecessor.TerminalError = previous.FileID, "failed", next.FileID, plan[0].TerminalError
	if _, err := restoreOfflineSuccessorRegistration([]store.ArchiveStagingRecord{predecessor}, registration); err != nil {
		t.Fatal(err)
	}
	registration.TimelineRevision++
	if _, err := restoreOfflineSuccessorRegistration([]store.ArchiveStagingRecord{predecessor}, registration); err == nil {
		t.Fatal("different successor revision admitted")
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(failed.TerminalError, &fields)
	var proof offlineSuccessorRevocation
	_ = json.Unmarshal(fields[offlineSuccessorRevocationKey], &proof)
	proof.TimelineRevision++
	fields[offlineSuccessorRevocationKey] = encode(proof)
	failed.TerminalError = encode(fields)
	if err := verifyArchiveSuccessors("session", failed, map[string]store.StorageArchiveFileV2{}); err == nil {
		t.Fatal("corrupt revocation proof accepted")
	}
	proof.TimelineRevision, proof.SuccessorFileID = 2, "not-a-uuid"
	fields[offlineSuccessorRevocationKey] = encode(proof)
	failed.TerminalError, failed.SuccessorFileID = encode(fields), proof.SuccessorFileID
	if err := verifyArchiveSuccessors("session", failed, map[string]store.StorageArchiveFileV2{}); err == nil {
		t.Fatal("invalid revoked successor identity accepted")
	}
}

func TestOfflineResourceSuccessorRegistrationRestoresOriginalRevision(t *testing.T) {
	previous := store.ArchiveBundleFile{SessionID: "session", FileID: "old", State: "failed", UploadVersion: 2, Purpose: "resource", SHA256: "hash", ByteLength: 7, TimelineRevision: 1, Resource: json.RawMessage(`{"resourceId":"resource"}`), SuccessorFileID: "11111111-1111-4111-8111-111111111111", TerminalError: json.RawMessage(`{"code":"staging_corrupt","message":"corrupt"}`)}
	next := previous
	next.FileID, next.State, next.SuccessorFileID, next.TerminalError = "11111111-1111-4111-8111-111111111111", "receiving", "", nil
	plan, err := PlanOfflineArchiveRevocations(store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{{File: next, Predecessors: []store.ArchiveBundleFile{previous}}}})
	if err != nil {
		t.Fatal(err)
	}
	registration := store.ArchiveStagingRecord{SessionID: next.SessionID, FileID: next.FileID, Purpose: next.Purpose, SHA256: next.SHA256, ByteLength: next.ByteLength, TimelineRevision: 2, Resource: next.Resource, State: "receiving"}
	predecessor := registration
	predecessor.FileID, predecessor.State, predecessor.SuccessorFileID, predecessor.TerminalError, predecessor.TimelineRevision = previous.FileID, "failed", next.FileID, plan[0].TerminalError, 1
	restored, err := restoreOfflineSuccessorRegistration([]store.ArchiveStagingRecord{predecessor}, registration)
	if err != nil || restored.TimelineRevision != 1 || registration.TimelineRevision != 2 {
		t.Fatal(restored, err)
	}
	registration.SHA256 = "other"
	if _, err := restoreOfflineSuccessorRegistration([]store.ArchiveStagingRecord{predecessor}, registration); err == nil {
		t.Fatal("different resource digest accepted")
	}
	registration.SHA256, registration.TimelineRevision = next.SHA256, 0
	if _, err := restoreOfflineSuccessorRegistration([]store.ArchiveStagingRecord{predecessor}, registration); err == nil {
		t.Fatal("future resource revision restored")
	}
}
