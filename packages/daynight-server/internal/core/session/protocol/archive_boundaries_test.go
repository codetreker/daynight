package sessionprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func archiveBoundaryResource() Resource {
	length, hash, mime := "1", strings.Repeat("a", 64), "text/plain"
	return Resource{ResourceID: uuid.NewString(), Status: "available", Name: "original", ByteLength: &length, SHA256: &hash, MediaType: &mime}
}

func TestArchiveManifestRejectsInvalidResourceClosureMetadata(t *testing.T) {
	id := uuid.NewString()
	for _, variant := range []string{"valid", "timeline-at-limit", "unknown-field", "oversized-timeline", "resources-not-array", "malformed-reference", "duplicate", "missing-blob", "invalid-blob", "oversized-original", "failed-with-blob", "invalid-native"} {
		t.Run(variant, func(t *testing.T) {
			resource, blob := archiveBoundaryResource(), uuid.NewString()
			ref := map[string]any{"resource": resource, "blobId": blob}
			doc := map[string]any{"schemaVersion": 3, "contentKind": "native_timeline", "recordId": id, "fence": Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, "provider": "codex", "nativeSessionId": "original", "controllerId": uuid.NewString(), "controllerInstanceId": uuid.NewString(), "timeline": ArchiveFileReference{FileID: uuid.NewString(), SHA256: strings.Repeat("a", 64), ByteLength: "1"}, "resources": []any{ref}, "completeness": "complete"}
			switch variant {
			case "timeline-at-limit":
				doc["timeline"] = ArchiveFileReference{FileID: uuid.NewString(), SHA256: strings.Repeat("a", 64), ByteLength: strconv.Itoa(MaxArchiveTimelineBytes)}
			case "unknown-field":
				doc["other"] = true
			case "oversized-timeline":
				doc["timeline"] = ArchiveFileReference{FileID: uuid.NewString(), SHA256: strings.Repeat("a", 64), ByteLength: strconv.Itoa(MaxArchiveTimelineBytes + 1)}
			case "resources-not-array":
				doc["resources"] = map[string]any{}
			case "malformed-reference":
				doc["resources"] = []any{map[string]any{"resource": resource}}
			case "duplicate":
				doc["resources"] = []any{ref, ref}
			case "missing-blob":
				ref["blobId"] = nil
			case "invalid-blob":
				ref["blobId"] = "foreign"
			case "oversized-original":
				length := strconv.Itoa(MaxArchiveBlobBytes + 1)
				resource.ByteLength = &length
				ref["resource"] = resource
			case "failed-with-blob":
				message := "unavailable"
				resource.Status, resource.MediaType, resource.ByteLength, resource.SHA256, resource.Error = "failed", nil, nil, nil, &message
				ref["resource"] = resource
			case "invalid-native":
				doc["nativeSessionId"] = "native\nother"
			}
			body, _ := json.Marshal(doc)
			if _, e := DecodeArchiveManifest(body); (e == nil) != (variant == "valid" || variant == "timeline-at-limit") {
				t.Fatal(variant, e)
			}
		})
	}
}

func TestArchiveHistoryRejectsBrokenExactInventory(t *testing.T) {
	resource := archiveBoundaryResource()
	for _, body := range []string{"", `{}`, `{"historyEpoch":"original","sourceThrough":"0","entries":null,"resources":[]}`, `{"historyEpoch":"original","sourceThrough":"0","entries":[],"resources":{}}`, `{"historyEpoch":"original","sourceThrough":"0","entries":[],"resources":[{}]}`} {
		if _, e := DecodeArchiveHistory([]byte(body)); e == nil {
			t.Fatal("invalid history accepted", body)
		}
	}
	duplicate, _ := json.Marshal(ArchiveHistoryContent{HistoryEpoch: "original", SourceThrough: "0", Entries: []TimelineEntry{}, Resources: []Resource{resource, resource}})
	if _, e := DecodeArchiveHistory(duplicate); e == nil {
		t.Fatal("duplicate original descriptor accepted")
	}
}

func TestArchiveClosureDistinguishesUnavailableAndMissingOriginals(t *testing.T) {
	for _, variant := range []string{"unavailable", "read-failure", "extra-descriptor", "digest", "invalid-timeline", "unresolved-projection", "invalid-reference"} {
		t.Run(variant, func(t *testing.T) {
			resource := archiveBoundaryResource()
			part := map[string]any{"type": "resource", "resourceId": resource.ResourceID, "label": "original"}
			entry := map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{part}}
			completeness := "complete"
			switch variant {
			case "unavailable":
				message := "not saved"
				resource.Status, resource.MediaType, resource.ByteLength, resource.SHA256, resource.Error = "failed", nil, nil, nil, &message
				completeness = "partial"
			case "invalid-reference":
				part["resourceId"] = 3
			case "unresolved-projection":
				entry["imageProjectionError"] = map[string]any{"code": "source_unavailable", "message": "unresolved"}
			}
			timeline, _ := json.Marshal(map[string]any{"entries": []any{entry}})
			if variant == "invalid-timeline" {
				timeline = []byte(`{"entries":null}`)
			}
			sum := sha256.Sum256(timeline)
			manifest := ArchiveManifest{Timeline: ArchiveFileReference{SHA256: hex.EncodeToString(sum[:]), ByteLength: strconv.Itoa(len(timeline))}, Resources: []ArchiveResourceReference{{Resource: resource}}, Completeness: completeness}
			if variant == "extra-descriptor" {
				manifest.Resources[0].Resource.ResourceID = uuid.NewString()
			}
			if variant == "digest" {
				manifest.Timeline.SHA256 = strings.Repeat("0", 64)
			}
			failure := errors.New("original read failed")
			_, e := VerifyArchiveClosure(manifest, timeline, func(ArchiveResourceReference) ([]byte, error) { return nil, failure })
			if variant == "unavailable" {
				if e != nil {
					t.Fatal(e)
				}
			} else if e == nil {
				t.Fatal("broken closure accepted", variant)
			}
			if variant == "read-failure" && !errors.Is(e, failure) {
				t.Fatal("read failure replaced", e)
			}
			if variant == "invalid-reference" {
				entryValue := TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"resource","resourceId":3,"label":"original"}]`)}}
				if _, _, e := ArchiveReferences([]TimelineEntry{entryValue}); e == nil {
					t.Fatal("non-UUID closure reference accepted")
				}
			}
		})
	}
}
