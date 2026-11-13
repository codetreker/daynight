//go:build integration

package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

type assistantBotTransport struct {
	botID string
	next  http.RoundTripper
}

func (r assistantBotTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	copy.Header.Set("X-Daynight-Bot-Id", r.botID)
	return r.next.RoundTrip(copy)
}

func assistantFixture(f *fixture, botID string) *fixture {
	result := *f
	client := *f.client
	client.Transport = assistantBotTransport{botID: botID, next: client.Transport}
	result.client = &client
	return &result
}

type botAttentionTransport struct{ next http.RoundTripper }

func (r botAttentionTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	copy.Header.Set("Daynight-Bot-Attention", "1")
	return r.next.RoundTrip(copy)
}

func createAssistantBots(t *testing.T, f *fixture) (string, string) {
	t.Helper()
	workerID := uuid.NewString()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": now, "value": value} }
	report := map[string]any{
		"machine":  map[string]any{"id": uuid.NewString(), "name": "Assistant API integration"},
		"platform": "linux", "workingDirectory": "/workspace", "sampledAt": now,
		"os":            probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "arm64"}),
		"cpu":           probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory":        probe(map[string]any{"usedBytes": 4, "totalBytes": 8}),
		"disk":          probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions":      map[string]any{"daynight": "1.0.0", "herdr": probe("1.0.0"), "codex": probe("1.0.0"), "copilot": probe("1.0.0")},
		"taskInventory": nil,
		"assistantHost": map[string]any{"protocolVersion": 1, "observedAt": now, "defaultCwd": "/workspace", "defaultProvider": "codex", "providers": []any{
			map[string]any{"provider": "codex", "available": true, "reason": nil, "model": nil, "args": []any{}},
			map[string]any{"provider": "claude", "available": false, "reason": "not_found", "model": nil, "args": []any{}},
			map[string]any{"provider": "copilot", "available": true, "reason": nil, "model": nil, "args": []any{}},
		}},
	}
	requestJSON[json.RawMessage](t, f, http.MethodPost, "/api/v1/me/workers/"+workerID+"/report", report, http.StatusOK)
	create := func(name string) string {
		t.Helper()
		id := uuid.NewString()
		bot := requestJSON[api.Bot](t, f, http.MethodPost, "/api/v1/me/bots", map[string]any{
			"id": id, "name": name, "overrides": map[string]any{"workerId": workerID, "provider": "codex", "cwd": "/workspace"},
		}, http.StatusOK)
		if bot.ID != id || bot.WorkerID != workerID || bot.OwnerUserID != f.userID {
			t.Fatalf("assistant definition differs: %+v", bot)
		}
		return bot.ID
	}
	return create("First assistant"), create("Receiving assistant")
}

func serverAPIAssistantTaskFlow(t *testing.T, f *fixture) {
	first, second := createAssistantBots(t, f)
	firstClient, secondClient := assistantFixture(f, first), assistantFixture(f, second)
	id := uuid.NewString()
	base := "/api/v1/assistant-tasks/" + id
	const originalManual = "Read the current records before organizing the workspace."
	created := requestJSON[api.AssistantTask](t, f, http.MethodPost, "/api/v1/assistant-tasks", map[string]any{
		"id": id, "name": "Organize workspace", "purpose": "Keep a shared record", "scope": "Workspace notes",
		"kind": "once", "takeover": "manual", "manual": map[string]any{"body": originalManual, "rules": []any{}},
	}, http.StatusOK)
	readTask := func() api.AssistantTask {
		t.Helper()
		return requestJSON[api.AssistantTask](t, f, http.MethodGet, base, nil, http.StatusOK)
	}
	if read := readTask(); read.ID != id || read.OwnerUserID != f.userID || read.Name != created.Name || read.Version != 1 || read.AssistantTaskClaim.State != "unowned" || read.Generation != 0 {
		t.Fatalf("created assistant task differs: %+v", read)
	}
	manual := requestJSON[api.AssistantTaskManual](t, firstClient, http.MethodGet, base+"/manual", nil, http.StatusOK)
	if manual.TaskID != id || manual.Body != originalManual || manual.Version != 1 {
		t.Fatalf("initial manual differs: %+v", manual)
	}
	token := func() string {
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(bytes)
	}
	firstToken, secondToken := token(), token()
	claimID := uuid.NewString()
	claim := requestJSON[api.AssistantTaskClaimResult](t, firstClient, http.MethodPost, base+"/claim", map[string]any{
		"operationId": claimID, "ifVersion": "1", "expectedGeneration": "0", "claimToken": firstToken,
	}, http.StatusOK)
	if claim.Operation.OperationID != claimID || claim.CurrentClaim.HolderBotID == nil || *claim.CurrentClaim.HolderBotID != first || claim.CurrentClaim.Generation != 1 || claim.CurrentClaim.State != "active" || claim.CurrentClaim.LeaseUntil == nil || claim.CurrentClaim.LeaseUntil.Sub(claim.Operation.AdmittedAt) != 5*time.Minute {
		t.Fatalf("claim result differs: %+v", claim)
	}
	renewed := requestJSON[api.AssistantTaskClaimResult](t, firstClient, http.MethodPost, base+"/renew", map[string]any{
		"operationId": uuid.NewString(), "claimGeneration": "1", "claimToken": firstToken,
	}, http.StatusOK)
	if renewed.CurrentClaim.Generation != 1 || renewed.CurrentClaim.CredentialOperationID == nil || *renewed.CurrentClaim.CredentialOperationID != claimID {
		t.Fatalf("renewal changed credential identity: %+v", renewed)
	}
	protected := func(body map[string]any, credential string, generation string) map[string]any {
		body["claimToken"], body["claimGeneration"] = credential, generation
		return body
	}
	operationID := uuid.NewString()
	item := requestJSON[api.AssistantTaskItem](t, firstClient, http.MethodPost, base+"/items", protected(map[string]any{
		"id": uuid.NewString(), "key": "workspace-notes", "episode": "1", "state": "open", "category": "organize", "appState": map[string]any{"operationId": operationID},
	}, firstToken, "1"), http.StatusOK)
	record := requestJSON[api.AssistantTaskRecord](t, firstClient, http.MethodPost, base+"/records", protected(map[string]any{
		"id": uuid.NewString(), "itemId": item.ID, "kind": "fact", "text": "The workspace has three notes.", "refs": []any{},
	}, firstToken, "1"), http.StatusOK)
	if record.TaskID != id || record.ItemID == nil || *record.ItemID != item.ID || record.AuthorBotID == nil || *record.AuthorBotID != first {
		t.Fatalf("record identity differs: %+v", record)
	}
	transfer := requestJSON[api.AssistantTaskClaimResult](t, firstClient, http.MethodPost, base+"/transfer", map[string]any{
		"operationId": uuid.NewString(), "ifVersion": strconv.FormatInt(readTask().Version, 10), "expectedGeneration": "1", "claimToken": firstToken, "targetBotId": second,
	}, http.StatusOK)
	if transfer.CurrentClaim.State != "pending" || transfer.CurrentClaim.Generation != 2 || transfer.CurrentClaim.HolderBotID == nil || *transfer.CurrentClaim.HolderBotID != second || transfer.CurrentClaim.CredentialOperationID != nil {
		t.Fatalf("transfer did not persist pending target: %+v", transfer)
	}
	transferredItem := requestJSON[api.AssistantTaskItem](t, secondClient, http.MethodGet, base+"/items/"+item.ID, nil, http.StatusOK)
	if transferredItem.FollowerBotID == nil || *transferredItem.FollowerBotID != second || transferredItem.ID != item.ID || transferredItem.Episode != item.Episode || !reflect.DeepEqual(transferredItem.AppState, item.AppState) {
		t.Fatalf("transfer lost item continuation: %+v", transferredItem)
	}
	bindID := uuid.NewString()
	bound := requestJSON[api.AssistantTaskClaimResult](t, secondClient, http.MethodPost, base+"/claim/bind", map[string]any{
		"operationId": bindID, "expectedGeneration": "2", "claimToken": secondToken,
	}, http.StatusOK)
	if bound.CurrentClaim.State != "active" || bound.CurrentClaim.Generation != 2 || bound.CurrentClaim.CredentialOperationID == nil || *bound.CurrentClaim.CredentialOperationID != bindID || !bound.CurrentClaim.LeaseUntil.Equal(*transfer.CurrentClaim.LeaseUntil) {
		t.Fatalf("binding changed the transfer lease: %+v", bound)
	}
	requestJSON[api.AssistantTaskClaimResult](t, secondClient, http.MethodPost, base+"/renew", map[string]any{
		"operationId": uuid.NewString(), "claimGeneration": "2", "claimToken": secondToken,
	}, http.StatusOK)
	historical := requestJSON[api.AssistantTaskClaimResult](t, secondClient, http.MethodGet, base+"/claim-operations/"+claimID, nil, http.StatusOK)
	if historical.Operation.ResultingGeneration != 1 || historical.CurrentClaim.Generation != 2 || historical.CurrentClaim.HolderBotID == nil || *historical.CurrentClaim.HolderBotID != second || historical.Operation.RequestFingerprint != claim.Operation.RequestFingerprint {
		t.Fatalf("receipt did not distinguish historical and current claim: %+v", historical)
	}
	appendix := requestJSON[api.AssistantTaskAppendix](t, secondClient, http.MethodPost, base+"/appendix", protected(map[string]any{
		"id": uuid.NewString(), "text": "Preserve existing references when organizing notes.", "sourceRecords": []string{record.ID},
	}, secondToken, "2"), http.StatusOK)
	appendices := requestJSON[api.AssistantTaskPage[api.AssistantTaskAppendix]](t, firstClient, http.MethodGet, base+"/appendix", nil, http.StatusOK)
	if value := expectID(t, appendices.Items, appendix.ID, func(v api.AssistantTaskAppendix) string { return v.ID }); value.Text != appendix.Text || !reflect.DeepEqual(value.SourceRecords, []string{record.ID}) {
		t.Fatalf("appendix readback differs: %+v", value)
	}
	attentionFixture := *f
	attentionClient := *f.client
	attentionClient.Transport = botAttentionTransport{next: attentionClient.Transport}
	attentionFixture.client = &attentionClient
	assertAttention := func(want int64) {
		t.Helper()
		bot := requestJSON[api.Bot](t, &attentionFixture, http.MethodGet, "/api/v1/me/bots/"+second, nil, http.StatusOK)
		listed := requestJSON[api.BotPage](t, &attentionFixture, http.MethodGet, "/api/v1/me/bots", nil, http.StatusOK)
		listBot := expectID(t, listed.Items, second, func(v api.Bot) string { return v.ID })
		if bot.AttentionCount == nil || listBot.AttentionCount == nil || *bot.AttentionCount != want || *listBot.AttentionCount != want {
			t.Fatalf("attention readback differs: detail=%v list=%v want=%d", bot.AttentionCount, listBot.AttentionCount, want)
		}
	}
	assertAttention(0)
	requestJSON[api.AssistantTaskEvent](t, secondClient, http.MethodPost, base+"/events", protected(map[string]any{
		"id": uuid.NewString(), "targetBotId": second, "type": "report", "payload": map[string]any{"text": "Review the workspace notes."},
	}, secondToken, "2"), http.StatusOK)
	assertAttention(1)
	proposal := requestJSON[struct {
		Proposal api.AssistantTaskProposal `json:"proposal"`
	}](t, secondClient, http.MethodPost, base+"/proposals", protected(map[string]any{
		"id": uuid.NewString(), "baseVersion": "1", "body": "Read the notes and preserve their references.", "rules": []any{}, "reason": "Keep the observed links intact.", "evidenceRecords": []string{record.ID},
	}, secondToken, "2"), http.StatusOK).Proposal
	assertAttention(2)
	seen := requestJSON[struct {
		TargetBotID string `json:"targetBotId"`
	}](t, f, http.MethodPost, "/api/v1/bots/"+second+"/attention/seen", map[string]any{}, http.StatusOK)
	if seen.TargetBotID != second {
		t.Fatalf("seen target differs: %+v", seen)
	}
	assertAttention(1)
	decision := requestJSON[api.AssistantTaskProposal](t, f, http.MethodPost, base+"/proposals/"+proposal.ID+"/decision", map[string]any{
		"ifVersion": strconv.FormatInt(readTask().Version, 10), "decision": "approved", "note": "Use this procedure.",
	}, http.StatusOK)
	assertAttention(0)
	updatedManual := requestJSON[api.AssistantTaskManual](t, firstClient, http.MethodGet, base+"/manual", nil, http.StatusOK)
	if decision.Status != "approved" || decision.DecidedAt == nil || updatedManual.Version != 2 || updatedManual.Body != proposal.Body || updatedManual.ProposalID == nil || *updatedManual.ProposalID != proposal.ID {
		t.Fatalf("approved manual differs: decision=%+v manual=%+v", decision, updatedManual)
	}
	rolledBack := requestJSON[api.AssistantTaskManual](t, f, http.MethodPost, base+"/manual/rollback", map[string]any{
		"ifVersion": strconv.FormatInt(readTask().Version, 10), "manualVersion": "1",
	}, http.StatusOK)
	currentManual := requestJSON[api.AssistantTaskManual](t, secondClient, http.MethodGet, base+"/manual", nil, http.StatusOK)
	if rolledBack.Version != 3 || currentManual.Version != 3 || currentManual.Body != manual.Body || !reflect.DeepEqual(currentManual.Rules, manual.Rules) {
		t.Fatalf("rollback did not append a copy: %+v", currentManual)
	}
	inquiry := requestJSON[api.AssistantTaskInquiry](t, firstClient, http.MethodPost, base+"/inquiries", map[string]any{
		"id": uuid.NewString(), "itemId": item.ID, "question": "Have the references been preserved?",
	}, http.StatusOK)
	if inquiry.FromBotID != first || inquiry.ToBotID != second || inquiry.State != "open" || inquiry.Deadline.Sub(inquiry.CreatedAt) != 5*time.Minute {
		t.Fatalf("inquiry routing differs: %+v", inquiry)
	}
	questions := requestJSON[api.AssistantTaskPage[api.AssistantTaskEvent]](t, secondClient, http.MethodGet, "/api/v1/assistant-task-events?state=pending", nil, http.StatusOK)
	findInquiryEvent := func(events []api.AssistantTaskEvent, kind, target string) api.AssistantTaskEvent {
		t.Helper()
		for _, event := range events {
			var payload struct {
				InquiryID string `json:"inquiryId"`
			}
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if event.TaskID == id && event.Type == kind && payload.InquiryID == inquiry.ID && event.TargetBotID == target {
				return event
			}
		}
		t.Fatalf("%s event for inquiry %s and target %s is absent: %+v", kind, inquiry.ID, target, events)
		return api.AssistantTaskEvent{}
	}
	findInquiryEvent(questions.Items, "inquiry", second)
	answer := requestJSON[api.AssistantTaskInquiry](t, secondClient, http.MethodPost, base+"/inquiries/"+inquiry.ID+"/answer", protected(map[string]any{
		"answer": "Yes, the existing references are preserved.",
	}, secondToken, "2"), http.StatusOK)
	inquiries := requestJSON[api.AssistantTaskPage[api.AssistantTaskInquiry]](t, firstClient, http.MethodGet, base+"/inquiries", nil, http.StatusOK)
	if value := expectID(t, inquiries.Items, inquiry.ID, func(v api.AssistantTaskInquiry) string { return v.ID }); value.State != "answered" || value.Answer != answer.Answer || value.AnsweredAt == nil {
		t.Fatalf("answer readback differs: %+v", value)
	}
	events := requestJSON[api.AssistantTaskPage[api.AssistantTaskEvent]](t, firstClient, http.MethodGet, "/api/v1/assistant-task-events?state=pending", nil, http.StatusOK)
	event := findInquiryEvent(events.Items, "answer", first)
	ackID := uuid.NewString()
	acked := requestJSON[api.AssistantTaskEvent](t, firstClient, http.MethodPost, base+"/events/"+event.ID+"/ack", map[string]any{"operationId": ackID}, http.StatusOK)
	if acked.State != "delivered" || acked.AckOperationID == nil || *acked.AckOperationID != ackID || acked.DeliveredAt == nil {
		t.Fatalf("event acknowledgment differs: %+v", acked)
	}
	delivered := requestJSON[api.AssistantTaskPage[api.AssistantTaskEvent]](t, firstClient, http.MethodGet, base+"/events?state=delivered&targetBotId="+first, nil, http.StatusOK)
	if value := expectID(t, delivered.Items, event.ID, func(v api.AssistantTaskEvent) string { return v.ID }); value.State != acked.State || value.TargetBotID != first {
		t.Fatalf("event readback differs: %+v", value)
	}
	page := requestJSON[api.AssistantTaskPage[api.AssistantTaskRecord]](t, f, http.MethodGet, base+"/records?limit=1", nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != record.ID || page.NextCursor == nil {
		t.Fatalf("first record page differs: %+v", page)
	}
	next := requestJSON[api.AssistantTaskPage[api.AssistantTaskRecord]](t, secondClient, http.MethodGet, base+"/records?limit=1&cursor="+url.QueryEscape(*page.NextCursor), nil, http.StatusOK)
	if len(next.Items) != 1 || next.Items[0].ID == record.ID || !next.Items[0].CreatedAt.After(record.CreatedAt) {
		t.Fatalf("next record page differs: %+v", next)
	}
	released := requestJSON[api.AssistantTaskClaimResult](t, f, http.MethodPost, base+"/release", map[string]any{
		"operationId": uuid.NewString(), "ifVersion": strconv.FormatInt(readTask().Version, 10), "expectedGeneration": "2",
	}, http.StatusOK)
	if released.CurrentClaim.State != "unowned" || released.CurrentClaim.Generation != 3 || released.CurrentClaim.HolderBotID != nil {
		t.Fatalf("release differs: %+v", released)
	}
	paused := requestJSON[api.AssistantTask](t, f, http.MethodPatch, base, map[string]any{"ifVersion": strconv.FormatInt(readTask().Version, 10), "state": "paused"}, http.StatusOK)
	if paused.State != "paused" || readTask().State != "paused" {
		t.Fatal("pause did not persist")
	}
	requestJSON[api.AssistantTask](t, f, http.MethodPatch, base, map[string]any{"ifVersion": strconv.FormatInt(paused.Version, 10), "state": "active"}, http.StatusOK)
	if readTask().State != "active" {
		t.Fatal("resume did not persist")
	}
	editedAppendix := requestJSON[api.AssistantTaskAppendix](t, f, http.MethodPatch, base+"/appendix/"+appendix.ID, map[string]any{
		"ifVersion": strconv.FormatInt(readTask().Version, 10), "text": "Keep verified source references.",
	}, http.StatusOK)
	if editedAppendix.State != "edited" || editedAppendix.Text != "Keep verified source references." || !reflect.DeepEqual(editedAppendix.SourceRecords, appendix.SourceRecords) {
		t.Fatalf("appendix edit differs: %+v", editedAppendix)
	}
	deletedAppendix := requestJSON[api.AssistantTaskAppendix](t, f, http.MethodDelete, base+"/appendix/"+appendix.ID, map[string]any{
		"ifVersion": strconv.FormatInt(readTask().Version, 10),
	}, http.StatusOK)
	if deletedAppendix.ID != appendix.ID || deletedAppendix.State != "deleted" || deletedAppendix.Text != "" || len(deletedAppendix.SourceRecords) != 0 || deletedAppendix.Version != editedAppendix.Version+1 {
		t.Fatalf("appendix deletion differs: %+v", deletedAppendix)
	}
	deletedAppendices := requestJSON[api.AssistantTaskPage[api.AssistantTaskAppendix]](t, f, http.MethodGet, base+"/appendix?state=deleted", nil, http.StatusOK)
	if value := expectID(t, deletedAppendices.Items, appendix.ID, func(v api.AssistantTaskAppendix) string { return v.ID }); value.Text != "" || len(value.SourceRecords) != 0 || value.Version != deletedAppendix.Version {
		t.Fatalf("appendix deletion did not persist: %+v", value)
	}
	deleted := requestJSON[api.AssistantTask](t, f, http.MethodDelete, base, map[string]any{"ifVersion": strconv.FormatInt(readTask().Version, 10)}, http.StatusOK)
	if deleted.ID != id || deleted.State != "deleted" {
		t.Fatalf("deletion differs: %+v", deleted)
	}
	remaining := requestJSON[api.AssistantTaskPage[api.AssistantTask]](t, f, http.MethodGet, "/api/v1/assistant-tasks", nil, http.StatusOK)
	for _, value := range remaining.Items {
		if value.ID == id {
			t.Fatal("deleted task remains in ordinary list")
		}
	}
}
