package codec

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestMessageEncodingPreservesCompleteAttributionAndMilliseconds(t *testing.T) {
	for _, milliseconds := range []int{0, 120, 123} {
		message := model.ThreadMessage{
			TaskID: "private-task", ID: "message-id", Body: "  <>&\"\\\n\t中文🌛\u2028\u2029  ",
			Author:    model.ThreadAuthor{UserID: "account-id"},
			CreatedAt: time.Date(2026, 11, 3, 5, 6, 7, milliseconds*int(time.Millisecond), time.FixedZone("east", 2*60*60)),
		}
		encoded, err := EncodeMessage(message, false)
		if err != nil {
			t.Fatal(err)
		}
		var result ThreadMessage
		if err := json.Unmarshal(encoded, &result); err != nil {
			t.Fatal(err)
		}
		if result.Body != message.Body || result.ID != message.ID || result.Author.DisplayName != nil || result.Author.Agent || result.ReplyTo != nil || result.CreatedAt != message.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z") {
			t.Fatalf("message lost fields: %#v", result)
		}
		text := string(encoded)
		for _, required := range []string{`"Agent":false`, `"displayName":null`, `\u003c\u003e\u0026`, `\u2028\u2029`} {
			if !strings.Contains(text, required) {
				t.Fatalf("missing encoded contract %q in %s", required, text)
			}
		}
		if strings.HasSuffix(text, "\n") || strings.Contains(text, "private-task") || strings.Contains(text, "replyTo") || strings.Contains(text, "execution") {
			t.Fatalf("unexpected bytes: %q", text)
		}
	}
}

func TestDetailsAndReplyUseSnapshotWithoutChangingDefaultResource(t *testing.T) {
	name, reply := "Alice", "reply-id"
	message := model.ThreadMessage{ID: "id", Author: model.ThreadAuthor{UserID: "user", DisplayName: &name, Agent: true, Execution: &model.ThreadExecution{ClaimID: "claim", WorkerID: "worker", Provider: "codex"}}, Body: "reply", ReplyTo: &reply, CreatedAt: time.Now()}
	for _, details := range []bool{false, true} {
		encoded, err := EncodeMessage(message, details)
		if err != nil {
			t.Fatal(err)
		}
		var result ThreadMessage
		if err := json.Unmarshal(encoded, &result); err != nil {
			t.Fatal(err)
		}
		if result.Author.DisplayName == nil || *result.Author.DisplayName != name || !result.Author.Agent || result.ReplyTo == nil || *result.ReplyTo != reply || (result.Author.Execution != nil) != details {
			t.Fatalf("snapshot mismatch: %#v", result)
		}
		if details && (result.Author.Execution.ClaimID != "claim" || result.Author.Execution.WorkerID != "worker" || result.Author.Execution.Provider != "codex") {
			t.Fatalf("execution fields mismatch: %#v", result.Author.Execution)
		}
	}
	message.Author.Agent = false
	encoded, err := EncodeMessage(message, true)
	if err != nil || strings.Contains(string(encoded), "execution") {
		t.Fatalf("ordinary author exposes source: %q, %v", encoded, err)
	}
}

func TestPageEncodingHasStableEmptyArrayAndBooleanFlags(t *testing.T) {
	encoded, err := EncodePage(model.ThreadPage{}, false)
	if err != nil || string(encoded) != `{"items":[],"hasMoreBefore":false,"hasMoreAfter":false}` {
		t.Fatalf("empty page: %q, %v", encoded, err)
	}
	message := model.ThreadMessage{ID: "id", CreatedAt: time.Date(2026, 11, 3, 0, 0, 0, 120000000, time.UTC)}
	for _, before := range []bool{false, true} {
		for _, after := range []bool{false, true} {
			page := model.ThreadPage{Items: []model.ThreadMessage{message}, HasMoreBefore: before, HasMoreAfter: after}
			encoded, err := EncodePage(page, true)
			if err != nil {
				t.Fatal(err)
			}
			var result ThreadPage
			if err := json.Unmarshal(encoded, &result); err != nil || len(result.Items) != 1 || result.HasMoreBefore != before || result.HasMoreAfter != after {
				t.Fatalf("page: %#v, %v", result, err)
			}
		}
	}
}
