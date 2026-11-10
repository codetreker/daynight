package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func historyBoundaryPosition(chunk bool) HistoryPosition {
	epoch := uuid.NewString()
	return HistoryPosition{Source: "live", SessionID: uuid.NewString(), Epoch: epoch, Version: epoch, Sequence: "3", EntryID: uuid.NewString(), Revision: "1", SHA256: strings.Repeat("a", 64), ByteLength: "10", Offset: "0", Chunk: chunk}
}

func TestHistoryUnavailableRunnersAndMalformedInputsRefuseBeforeAccess(t *testing.T) {
	s := &Execution{Engine: NewEngine(nil)}
	position := historyBoundaryPosition(true)
	for _, operation := range []string{"current", "directory", "archive", "status", "page", "entry"} {
		t.Run(operation, func(t *testing.T) {
			var err error
			switch operation {
			case "current":
				_, err = s.TaskCurrentIdentity(t.Context(), model.Principal{}, "p", "t")
			case "directory":
				_, err = s.TaskDirectory(t.Context(), model.Principal{}, "p", "t", "", 1)
			case "archive":
				_, err = s.TaskArchiveContent(t.Context(), model.Principal{}, "p", "t", position.SessionID)
			case "status":
				_, err = s.TaskArchiveStatus(t.Context(), model.Principal{}, "p", "t", position.SessionID)
			case "page":
				_, err = s.ReadLivePage(t.Context(), model.Principal{}, "p", "t", position.SessionID, LiveHistoryRequest{Limit: 1})
			case "entry":
				_, err = s.ReadLiveEntry(t.Context(), model.Principal{}, "p", "t", position.SessionID, position.Epoch, position.Cursor())
			}
			if err == nil {
				t.Fatal("read succeeded without an authorization runner")
			}
		})
	}
	pagePosition := position
	pagePosition.Chunk = false
	for _, in := range []LiveHistoryRequest{{}, {Limit: 201}, {Limit: 1, ResponseOverhead: -1}, {Limit: 1, ResponseOverhead: sp.MaxHistoryResponseBytes}, {Limit: 1, Before: "invalid"}, {Limit: 1, Before: pagePosition.Cursor(), Epoch: uuid.NewString()}} {
		if _, err := s.ReadLivePage(t.Context(), model.Principal{}, "p", "t", position.SessionID, in); err == nil {
			t.Fatalf("invalid page reached access: %#v", in)
		}
	}
	if _, err := s.ReadLiveEntry(t.Context(), model.Principal{}, "p", "t", position.SessionID, position.Epoch, "invalid"); err == nil {
		t.Fatal("invalid chunk cursor accepted")
	}
	_, err := s.ReadLiveEntry(t.Context(), model.Principal{}, "p", "t", uuid.NewString(), position.Epoch, position.Cursor())
	botFault(t, err, "reset_required")
}

func TestHistoryCredentialRejectsMissingAndUnsupportedIdentityBeforeDAO(t *testing.T) {
	op, err := NewEngine(nil).BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	dao := &historyAuthorizationDAO{}
	for _, actor := range []model.Principal{{}, {Kind: "unsupported", UserID: uuid.NewString(), CredentialID: uuid.NewString()}} {
		if err = op.LockTaskReadCredential(t.Context(), historyAuthorizationScope{dao}, actor); err == nil {
			t.Fatal("invalid credential accepted")
		}
	}
	if dao.calls != 0 {
		t.Fatal("invalid principal reached credential storage")
	}
}

func TestHistoryDirectoryAndArchiveStatusPreserveStorageFailures(t *testing.T) {
	f, v := connectFixture(t)
	prepareHistoryReads(f)
	if _, err := f.s.TaskDirectory(t.Context(), f.p, f.project, f.task, "invalid", 1); err == nil {
		t.Fatal("malformed directory cursor accepted")
	}
	cause := errors.New("history metadata unavailable")
	f.dao.SessionArchiveFn = func(_ context.Context, id string) (sp.ArchiveStatus, string, error) {
		if id != v.SessionID {
			t.Fatal("archive status changed Session identity")
		}
		return sp.ArchiveStatus{State: "pending"}, "", nil
	}
	phase := f.ArchivePhase(t.Context(), map[string]int{"SessionArchive": 1})
	status, err := f.s.TaskArchiveStatus(phase, f.p, f.project, f.task, v.SessionID)
	f.dao.FinishContext(phase)
	if err != nil || status.State != "pending" {
		t.Fatalf("status %#v %v", status, err)
	}
	f.dao.SessionArchiveFn = func(context.Context, string) (sp.ArchiveStatus, string, error) { return sp.ArchiveStatus{}, "", cause }
	phase = f.ArchivePhase(t.Context(), map[string]int{"SessionArchive": 1})
	_, err = f.s.TaskArchiveStatus(phase, f.p, f.project, f.task, v.SessionID)
	f.dao.FinishContext(phase)
	if !errors.Is(err, cause) {
		t.Fatal("archive status error lost", err)
	}
}

func TestHistoryResourceMetadataIsBoundedWithoutChangingBodyReferences(t *testing.T) {
	parts := []map[string]string{{"type": "text", "text": "message"}}
	resources := []sp.Resource{{ResourceID: uuid.NewString(), Status: "available", Name: "unreferenced"}}
	for i := 0; i < 21; i++ {
		id := uuid.NewString()
		parts = append(parts, map[string]string{"type": "resource", "resourceId": id})
		resources = append(resources, sp.Resource{ResourceID: id, Status: "available", Name: strings.Repeat("汉", 342)})
	}
	entry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "user_message", Data: map[string]json.RawMessage{"content": encode(parts)}}
	item, err := historyItem("session", "epoch", "live", "epoch", entry, resources)
	if err != nil || len(item.Resources) != 20 || !item.ResourcesTruncated || item.Role == nil || *item.Role != "user" {
		t.Fatalf("bounded resource metadata %#v %v", item, err)
	}
	for i, resource := range item.Resources {
		if resource.ResourceID != resources[i+1].ResourceID || len(resource.Name) != 1023 || !utf8.ValidString(resource.Name) {
			t.Fatal("resource identity or Unicode name corrupted")
		}
	}
	canonical, _ := canonicalHistoryJSON(entry)
	if string(item.Body) != string(canonical) || item.Truncated || item.ContentRef != nil {
		t.Fatal("metadata bounds changed the complete message body")
	}
	entry.Data["content"] = json.RawMessage(`invalid`)
	if _, err = historyItem("session", "epoch", "live", "epoch", entry, nil); err == nil {
		t.Fatal("corrupt entry body accepted")
	}
	for _, value := range []struct {
		in, want string
		limit    int
	}{{"short", "short", 5}, {"a🙂b", "a", 3}, {"a🙂b", "a🙂", 5}, {"🙂", "", 1}} {
		if got := trimUTF8(value.in, value.limit); got != value.want {
			t.Fatalf("UTF-8 trim %q -> %q want %q", value.in, got, value.want)
		}
	}
}

func TestLiveHistoryPageRejectsInconsistentContinuationsAndReferences(t *testing.T) {
	for _, scenario := range []string{"valid", "missing_cursor", "empty_page_cursor", "malformed_cursor", "foreign_cursor", "sequence_mismatch", "past_before", "malformed_ref", "foreign_ref", "revision_ref", "offset_ref"} {
		t.Run(scenario, func(t *testing.T) {
			position := historyBoundaryPosition(false)
			cursor := position.Cursor()
			ref := position
			ref.Chunk = true
			item := sp.MessageItem{EntryID: ref.EntryID, EntrySeq: position.Sequence, Revision: ref.Revision, ContentRef: &sp.EntryContentRef{Cursor: ref.Cursor(), SHA256: ref.SHA256, ByteLength: ref.ByteLength}}
			page := sp.MessagePage{SessionID: position.SessionID, HistoryEpoch: position.Epoch, Items: []sp.MessageItem{item}, BeforeCursor: &cursor, HasMoreBefore: true, ObservedAt: time.Now()}
			in := LiveHistoryRequest{Limit: 1}
			switch scenario {
			case "missing_cursor":
				page.BeforeCursor = nil
			case "empty_page_cursor":
				page.Items = nil
			case "malformed_cursor":
				cursor = "invalid"
			case "foreign_cursor":
				position.SessionID = uuid.NewString()
				cursor = position.Cursor()
			case "sequence_mismatch":
				position.Sequence = "1"
				cursor = position.Cursor()
			case "past_before":
				in.Before = position.Cursor()
			case "malformed_ref":
				item.ContentRef.Cursor = "invalid"
			case "foreign_ref":
				ref.SessionID = uuid.NewString()
				item.ContentRef.Cursor = ref.Cursor()
			case "revision_ref":
				ref.Revision = "2"
				item.ContentRef.Cursor = ref.Cursor()
			case "offset_ref":
				ref.Offset = "1"
				item.ContentRef.Cursor = ref.Cursor()
			}
			err := validateLiveHistoryPage(page, in)
			if scenario == "valid" && err != nil || scenario != "valid" && err == nil {
				t.Fatalf("continuation validation %s: %v", scenario, err)
			}
		})
	}
}

func TestHistoryProjectionPreservesExplicitPartialEvidenceAndRefusesInvalidBudget(t *testing.T) {
	position := historyBoundaryPosition(false)
	entry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "tool_call", Data: map[string]json.RawMessage{"truncated": json.RawMessage(`true`)}}
	for _, scenario := range []string{"tool_truncated", "resource_unavailable", "invalid_limit", "invalid_budget", "malformed_cursor", "malformed_body", "metadata_budget"} {
		t.Run(scenario, func(t *testing.T) {
			entries := []sp.TimelineEntry{entry}
			var resources []sp.Resource
			limit, overhead, token := 1, 0, ""
			switch scenario {
			case "resource_unavailable":
				entries = nil
				resources = []sp.Resource{{ResourceID: uuid.NewString(), Status: "unavailable"}}
			case "invalid_limit":
				limit = 0
			case "invalid_budget":
				overhead = -1
			case "malformed_cursor":
				token = "invalid"
			case "malformed_body":
				entries[0].Data = map[string]json.RawMessage{"truncated": json.RawMessage(`invalid`)}
			case "metadata_budget":
				overhead = sp.MaxHistoryResponseBytes - 1
			}
			page, err := BuildHistoryPage(position.SessionID, position.Epoch, "live", position.Epoch, entries, resources, token, limit, false, overhead, time.Now())
			if scenario == "tool_truncated" || scenario == "resource_unavailable" {
				if err != nil || page.Coverage.State != "partial" || page.Coverage.Reason == nil {
					t.Fatalf("partial source lost evidence: %#v %v", page, err)
				}
			} else if err == nil {
				t.Fatal("invalid projection succeeded")
			}
		})
	}
}
