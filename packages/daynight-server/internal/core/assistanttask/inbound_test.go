package assistanttask

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

const inboxID = "77777777-7777-4777-8777-777777777777"
const projectID = "88888888-8888-4888-8888-888888888888"
const webhookEventID = "99999999-9999-4999-8999-999999999999"

// Uppercase hex is parseable but not the canonical lowercase spelling.
const noncanonicalID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"

func cloudEvent(t *testing.T) []byte {
	t.Helper()
	body, err := protocol.Render(webhookEventID, protocol.Fact{Type: protocol.Created, ProjectID: projectID, TaskID: taskID, OccurredAt: epoch.Add(-time.Second), TaskVersion: 3, Status: "todo"})
	if err != nil {
		t.Fatal(err)
	}
	return body
}
func externalInput(body string) InboundInput {
	return InboundInput{InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "text/plain", Body: []byte(body)}
}
func daynightInput(t *testing.T) InboundInput {
	return InboundInput{InboxID: inboxID, Classification: InboundDaynight, ReceivedAt: epoch, MediaType: protocol.MediaType, IdempotencyKey: webhookEventID, Body: cloudEvent(t)}
}
func decodePayload(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	return fields
}

func TestInboundExternalPayloadStoresBodyDigestAndKey(t *testing.T) {
	body := `{"alert":"disk <full>","n":12345678901234567890}`
	input := externalInput(body)
	input.MediaType = "Application/Problem+JSON; charset=UTF-8"
	input.IdempotencyKey = "delivery-1"
	input.ReceivedAt = epoch.In(time.FixedZone("UTC+8", 8*3600))
	raw, err := BuildInboundPayload(input)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	want := map[string]any{"inboxId": inboxID, "classification": "external", "receivedAt": "2026-11-12T12:00:00Z", "mediaType": "application/problem+json", "idempotencyKey": "delivery-1", "body": body, "byteLength": float64(len(body)), "sha256": hex.EncodeToString(sum[:])}
	if got := decodePayload(t, raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("payload:\n got %#v\nwant %#v", got, want)
	}
	if !strings.Contains(string(raw), `disk <full>`) {
		t.Fatalf("HTML characters were escaped: %s", raw)
	}
}

func TestInboundPayloadSizeIsBoundedForWorstCaseBodies(t *testing.T) {
	// Control characters are the worst case: each byte becomes \u00XX.
	const overhead = 1024
	for name, body := range map[string]string{
		"control": strings.Repeat("\x01", InboundMaxBodyBytes),
		"html":    strings.Repeat("<", InboundMaxBodyBytes),
	} {
		raw, err := BuildInboundPayload(externalInput(body))
		if err != nil {
			t.Fatal(err)
		}
		if len(raw) > 6*InboundMaxBodyBytes+overhead {
			t.Fatalf("%s payload has %d bytes", name, len(raw))
		}
		if name == "html" && len(raw) > InboundMaxBodyBytes+overhead {
			t.Fatalf("HTML payload was escaped to %d bytes", len(raw))
		}
	}
}

func TestInboundExternalTextWithoutKeyStoresNullKey(t *testing.T) {
	raw, err := BuildInboundPayload(externalInput(""))
	if err != nil {
		t.Fatal(err)
	}
	fields := decodePayload(t, raw)
	if key, ok := fields["idempotencyKey"]; !ok || key != nil || fields["mediaType"] != "text/plain" || fields["byteLength"] != float64(0) || fields["body"] != "" {
		t.Fatalf("payload: %s", raw)
	}
}

func TestInboundBodyLimitIsExactly64KiB(t *testing.T) {
	if InboundMaxBodyBytes != 64*1024 {
		t.Fatalf("limit %d", InboundMaxBodyBytes)
	}
	raw, err := BuildInboundPayload(externalInput(strings.Repeat("a", 64*1024)))
	if err != nil || decodePayload(t, raw)["byteLength"] != float64(64*1024) {
		t.Fatalf("limit body: %v", err)
	}
	_, err = BuildInboundPayload(externalInput(strings.Repeat("a", 64*1024+1)))
	requireCode(t, err, "invalid_input")
	oversized := daynightInput(t)
	oversized.Body = append(oversized.Body, []byte(strings.Repeat(" ", 64*1024))...)
	_, err = BuildInboundPayload(oversized)
	requireCode(t, err, "invalid_input")
}

func TestInboundRejectsInvalidBodiesAndMediaTypes(t *testing.T) {
	for name, input := range map[string]InboundInput{
		"invalid utf-8":       externalInput("ok\xff"),
		"nul text":            externalInput("a\x00b"),
		"nul json":            {InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "application/json", Body: []byte("\"a\x00\"")},
		"invalid json":        {InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "application/json", Body: []byte(`{"a":`)},
		"empty json":          {InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "application/vnd.x+json"},
		"unsupported media":   {InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "text/html", Body: []byte("<p>")},
		"non-utf-8 charset":   {InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "text/plain; charset=iso-8859-1", Body: []byte("x")},
		"unparsable media":    {InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, Body: []byte("x")},
		"noncanonical inbox":  {InboxID: noncanonicalID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "text/plain"},
		"zero inbox":          {InboxID: "00000000-0000-0000-0000-000000000000", Classification: InboundExternal, ReceivedAt: epoch, MediaType: "text/plain"},
		"missing receipt":     {InboxID: inboxID, Classification: InboundExternal, MediaType: "text/plain"},
		"empty class":         {InboxID: inboxID, ReceivedAt: epoch, MediaType: "text/plain"},
		"unknown class":       {InboxID: inboxID, Classification: "github", ReceivedAt: epoch, MediaType: "text/plain"},
		"external with actor": {InboxID: inboxID, Classification: InboundExternal, ReceivedAt: epoch, MediaType: "text/plain", Actor: &InboundActor{Kind: InboundActorSystem}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := BuildInboundPayload(input)
			requireCode(t, err, "invalid_input")
		})
	}
}

func TestInboundIdempotencyKeyBounds(t *testing.T) {
	for key, valid := range map[string]bool{
		"!": true, "~": true, strings.Repeat("k", 200): true, "Webhook-1:abc/DEF": true,
		strings.Repeat("k", 201): false, "has space": false, "tab\t": false, "del\x7f": false, "é": false,
	} {
		if ValidInboundIdempotencyKey(key) != valid {
			t.Errorf("%q: want %v", key, valid)
		}
		input := externalInput("x")
		input.IdempotencyKey = key
		raw, err := BuildInboundPayload(input)
		if valid && (err != nil || decodePayload(t, raw)["idempotencyKey"] != key) {
			t.Errorf("%q: %s %v", key, raw, err)
		}
		if !valid {
			requireCode(t, err, "invalid_input")
		}
	}
	if ValidInboundIdempotencyKey("") {
		t.Fatal("empty key accepted")
	}
}

func TestInboundDaynightPayloadDecodesFactsFromSourceBody(t *testing.T) {
	raw, err := BuildInboundPayload(daynightInput(t))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"inboxId":"` + inboxID + `","classification":"daynight","receivedAt":"2026-11-12T12:00:00Z","mediaType":"application/cloudevents+json","idempotencyKey":"` + webhookEventID + `","eventType":"task.created","projectId":"` + projectID + `","taskId":"` + taskID + `","occurredAt":"2026-11-12T11:59:59Z","actor":null,"data":{"paused":false,"projectId":"` + projectID + `","status":"todo","taskId":"` + taskID + `","taskVersion":"3"}}`
	if string(raw) != want {
		t.Fatalf("payload:\n got %s\nwant %s", raw, want)
	}
}

func TestInboundDaynightActorVariants(t *testing.T) {
	user, bot := ptr(ownerID), ptr(botID)
	for name, tc := range map[string]struct {
		actor *InboundActor
		want  string
	}{
		"unknown": {nil, `null`},
		"user":    {&InboundActor{Kind: InboundActorUser, UserID: user}, `{"kind":"user","userId":"` + ownerID + `"}`},
		"bot":     {&InboundActor{Kind: InboundActorBot, UserID: user, BotID: bot}, `{"kind":"bot","userId":"` + ownerID + `","botId":"` + botID + `"}`},
		"system":  {&InboundActor{Kind: InboundActorSystem}, `{"kind":"system"}`},
	} {
		t.Run(name, func(t *testing.T) {
			input := daynightInput(t)
			input.Actor = tc.actor
			raw, err := BuildInboundPayload(input)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err = json.Unmarshal(raw, &fields); err != nil || string(fields["actor"]) != tc.want {
				t.Fatalf("actor: %s %v", fields["actor"], err)
			}
		})
	}
	for name, actor := range map[string]InboundActor{
		"user with bot":          {Kind: InboundActorUser, UserID: user, BotID: bot},
		"user without user":      {Kind: InboundActorUser},
		"user noncanonical":      {Kind: InboundActorUser, UserID: ptr(noncanonicalID)},
		"bot without bot":        {Kind: InboundActorBot, UserID: user},
		"bot without user":       {Kind: InboundActorBot, BotID: bot},
		"bot zero id":            {Kind: InboundActorBot, UserID: user, BotID: ptr("00000000-0000-0000-0000-000000000000")},
		"system with user":       {Kind: InboundActorSystem, UserID: user},
		"system with bot":        {Kind: InboundActorSystem, BotID: bot},
		"unknown kind":           {Kind: "worker", UserID: user},
		"empty kind with fields": {UserID: user},
	} {
		t.Run(name, func(t *testing.T) {
			input := daynightInput(t)
			input.Actor = &actor
			_, err := BuildInboundPayload(input)
			requireCode(t, err, "invalid_input")
		})
	}
}

func TestInboundDaynightRejectsUnverifiableSources(t *testing.T) {
	for name, mutate := range map[string]func(*InboundInput){
		"plain json media": func(i *InboundInput) { i.MediaType = "application/json" },
		"text media":       func(i *InboundInput) { i.MediaType = "text/plain" },
		"not cloudevent":   func(i *InboundInput) { i.Body = []byte(`{"id":"x"}`) },
		"other key":        func(i *InboundInput) { i.IdempotencyKey = "delivery-1" },
		"missing key":      func(i *InboundInput) { i.IdempotencyKey = "" },
		"empty body":       func(i *InboundInput) { i.Body = nil },
	} {
		t.Run(name, func(t *testing.T) {
			input := daynightInput(t)
			mutate(&input)
			_, err := BuildInboundPayload(input)
			requireCode(t, err, "invalid_input")
		})
	}
}

func TestAddInboundEventWritesUnattendedSystemEvent(t *testing.T) {
	input := externalInput("hello")
	input.ReceivedAt = epoch.In(time.FixedZone("UTC-5", -5*3600))
	want, err := BuildInboundPayload(input)
	if err != nil {
		t.Fatal(err)
	}
	var saved model.AssistantTaskEvent
	d := &daoStub{insertEvent: func(_ context.Context, event model.AssistantTaskEvent) (bool, error) { saved = event; return true, nil }}
	result, err := New().AddInboundEvent(context.Background(), d, baseTask(), entryID, targetID, input)
	if err != nil || result.ID != entryID || saved.ID != entryID || saved.Type != "inbound" || saved.Attention || saved.State != "pending" || saved.TargetBotID != targetID || saved.TaskID != taskID || saved.OwnerUserID != ownerID || string(saved.Payload) != string(want) || !saved.CreatedAt.Equal(epoch) || saved.CreatedAt.Location() != time.UTC || saved.RequestFingerprint == "" {
		t.Fatalf("event: %#v %v", saved, err)
	}
}

func TestAddInboundEventRejectsBeforeWritingAndReportsInsertFailures(t *testing.T) {
	for name, tc := range map[string]struct {
		id, target string
		input      InboundInput
	}{
		"event id":  {"bad", targetID, externalInput("x")},
		"target":    {entryID, noncanonicalID, externalInput("x")},
		"payload":   {entryID, targetID, externalInput("\xff")},
		"class":     {entryID, targetID, InboundInput{InboxID: inboxID, ReceivedAt: epoch, MediaType: "text/plain"}},
		"zero time": {entryID, targetID, InboundInput{InboxID: inboxID, Classification: InboundExternal, MediaType: "text/plain"}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := New().AddInboundEvent(context.Background(), &daoStub{}, baseTask(), tc.id, tc.target, tc.input)
			requireCode(t, err, "invalid_input")
		})
	}
	d := &daoStub{insertEvent: func(context.Context, model.AssistantTaskEvent) (bool, error) { return false, nil }}
	_, err := New().AddInboundEvent(context.Background(), d, baseTask(), entryID, targetID, externalInput("x"))
	requireCode(t, err, "operation_conflict")
	d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) { return false, sentinel }
	if _, err = New().AddInboundEvent(context.Background(), d, baseTask(), entryID, targetID, externalInput("x")); !errors.Is(err, sentinel) {
		t.Fatalf("insert error: %v", err)
	}
}

func TestBotCannotAddInboundEventForItself(t *testing.T) {
	d := baseDAO(t, baseTask())
	_, err := New().AddEvent(context.Background(), d, botActor(), EventInput{Mutation: mutation(), TargetBotID: botID, Type: InboundEventType, Payload: json.RawMessage(`{}`)})
	requireCode(t, err, "forbidden")
}
