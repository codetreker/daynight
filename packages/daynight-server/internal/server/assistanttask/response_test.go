package assistanttask

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestResponsesExposeOnlyPublicFieldsAndExactVersions(t *testing.T) {
	at := time.Date(2026, 11, 12, 21, 0, 0, 0, time.FixedZone("test", 9*3600))
	const large int64 = 9007199254740993
	task := core.TaskResult{Task: model.AssistantTask{ID: testTask, Name: "task", Version: large, ManualVersion: large, ClaimTokenHash: pointer("private-token-hash"), RequestFingerprint: "private-create-fingerprint", HolderDeleted: true, CreatedAt: at, UpdatedAt: at}, Claim: model.AssistantTaskClaim{State: "expired", Generation: large, HolderBotID: pointer(testBot), CredentialOperationID: pointer(testOperation), ClaimedAt: &at, RenewedAt: &at, LeaseUntil: &at, ObservedAt: at}}
	value := taskResponse(task)
	if value.CreatedAt.Location() != time.UTC || value.ObservedAt.Location() != time.UTC || value.ClaimedAt.Location() != time.UTC || value.AssistantTaskClaim.State != "expired" {
		t.Fatal("authoritative projection changed")
	}
	data, err := json.Marshal(value)
	if err != nil || !strings.Contains(string(data), `"version":"9007199254740993"`) || !strings.Contains(string(data), `"claimGeneration":"9007199254740993"`) || strings.Contains(string(data), "private-") || strings.Contains(string(data), "holderDeleted") {
		t.Fatalf("projection: %s %v", data, err)
	}
	manual := manualResponse(model.AssistantTaskManual{Version: large, Body: "body", Rules: json.RawMessage(`[]`), CreatedAt: at})
	appendix := appendixResponse(model.AssistantTaskAppendix{Version: large, RequestFingerprint: "private-appendix-fingerprint", CreatedAt: at, UpdatedAt: at})
	proposal := proposalResponse(model.AssistantTaskProposal{BaseVersion: large, RequestFingerprint: "private-proposal-fingerprint", CreatedAt: at, DecidedAt: &at})
	item := itemResponse(model.AssistantTaskItem{Version: large, Episode: large, RequestFingerprint: "private-item-fingerprint", CreatedAt: at, UpdatedAt: at})
	record := recordResponse(model.AssistantTaskRecord{RequestFingerprint: "private-record-fingerprint", CreatedAt: at})
	event := eventResponse(model.AssistantTaskEvent{RequestFingerprint: "private-event-fingerprint", AckFingerprint: pointer("private-ack-fingerprint"), CreatedAt: at, DeliveredAt: &at, SeenAt: &at})
	inquiry := inquiryResponse(model.AssistantTaskInquiry{RequestFingerprint: "private-inquiry-fingerprint", CreatedAt: at, Deadline: at, AnsweredAt: &at})
	for _, response := range []any{manual, appendix, proposal, item, record, event, inquiry} {
		encoded, err := json.Marshal(response)
		if err != nil || strings.Contains(string(encoded), "private-") || strings.Contains(string(encoded), "+09:00") {
			t.Fatalf("private field or non-UTC time: %s %v", encoded, err)
		}
	}
	if appendix.SourceRecords == nil || proposal.EvidenceRecords == nil {
		t.Fatal("nil list exposed as null")
	}
}

func TestPagesAndProposalMatchesProjectAllRows(t *testing.T) {
	source := model.AssistantTaskPage[model.AssistantTaskManual]{Items: []model.AssistantTaskManual{{TaskID: testTask, Version: 1}, {TaskID: testTask, Version: 2}}, NextCursor: pointer("opaque"), ObservedAt: time.Now()}
	page := pageResponse(source, manualResponse)
	if len(page.Items) != 2 || page.Items[1].Version != 2 || page.NextCursor != source.NextCursor {
		t.Fatal("page projection changed")
	}
	data, err := json.Marshal(proposalResultResponse(core.ProposalResult{Proposal: model.AssistantTaskProposal{ID: testID}, RejectedMatches: []model.AssistantTaskProposal{{ID: testOperation, Status: "rejected"}}}))
	if err != nil || !strings.Contains(string(data), `"rejectedMatches":[{`) || !strings.Contains(string(data), testOperation) {
		t.Fatalf("matches=%s err=%v", data, err)
	}
}

func TestRelatedAppendicesResponseListsItemsWithoutContinuation(t *testing.T) {
	at := time.Date(2026, 11, 19, 8, 0, 0, 0, time.FixedZone("east", 8*3600))
	data, err := json.Marshal(relatedAppendicesResponse(model.AssistantTaskRelatedAppendices{ObservedAt: at}))
	if err != nil || string(data) != `{"items":[],"observedAt":"2026-11-19T00:00:00Z"}` {
		t.Fatalf("empty related response: %s %v", data, err)
	}
	item := model.AssistantTaskAppendix{ID: testID, TaskID: testTask, Text: "Restart", State: "edited", Version: 3, CreatedAt: at, UpdatedAt: at, LastValidatedAt: &at, SuccessCount: 2}
	response := relatedAppendicesResponse(model.AssistantTaskRelatedAppendices{Items: []model.AssistantTaskAppendix{item}, ObservedAt: at})
	if len(response.Items) != 1 || !reflect.DeepEqual(response.Items[0], appendixResponse(item)) {
		t.Fatalf("related items not projected as appendices: %#v", response.Items)
	}
}

func TestAppendixResponseOmitsUnusedScopeAndValidation(t *testing.T) {
	at := time.Date(2026, 11, 19, 8, 0, 0, 0, time.FixedZone("east", 8*3600))
	base := model.AssistantTaskAppendix{ID: testID, TaskID: testTask, Text: "Restart", State: "active", Version: 2, SourceRecords: []string{}, CreatedAt: at, UpdatedAt: at,
		Scope: model.AssistantTaskAppendixScope{ProjectIDs: []string{}, EventTypes: []string{}, ItemCategories: []string{}}}
	data, err := json.Marshal(appendixResponse(base))
	if err != nil || strings.Contains(string(data), "scope") || strings.Contains(string(data), "validation") {
		t.Fatalf("unused scope or validation encoded: %s %v", data, err)
	}
	scoped := base
	scoped.Scope = model.AssistantTaskAppendixScope{ItemCategories: []string{"build"}}
	scoped.SuccessCount, scoped.FailureCount, scoped.LastValidatedAt = 9007199254740993, 0, &at
	response := appendixResponse(scoped)
	scoped.Scope.ItemCategories[0] = "changed"
	data, err = json.Marshal(response)
	want := `"scope":{"projectIds":[],"eventTypes":[],"itemCategories":["build"]},"validation":{"successCount":"9007199254740993","failureCount":"0","lastValidatedAt":"2026-11-19T00:00:00Z"}}`
	if err != nil || !strings.HasSuffix(string(data), want) {
		t.Fatalf("scope or validation encoding: %s %v", data, err)
	}
}
