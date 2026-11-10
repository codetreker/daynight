package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// The fixed bytes below are authored from wire v1/schema 1, independently
// of Render. Hashes are SHA-256 of those literal UTF-8 bytes, without LF.
func TestSixTypesIndependentWireOracles(t *testing.T) {
	const eventID = "a0be4d96-fb33-41ba-a7bd-7885c1e94247"
	const projectID = "22222222-2222-4222-8222-222222222222"
	const taskID = "33333333-3333-4333-8333-333333333333"
	const messageID = "44444444-4444-4444-8444-444444444444"
	const replyID = "55555555-5555-4555-8555-555555555555"
	at := time.Date(2026, 11, 6, 8, 0, 0, 0, time.UTC)
	common := Fact{ProjectID: projectID, TaskID: taskID, TaskVersion: 42, OccurredAt: at}
	created := common
	created.Type = Created
	created.Status = "todo"
	created.Paused = true
	status := common
	status.Type = StatusChanged
	status.PreviousStatus = "done"
	status.Status = "cancelled"
	paused := common
	paused.Type = Paused
	paused.Paused = true
	deleted := common
	deleted.Type = Deleted
	deleted.DeletedAt = &at
	step := common
	step.Type = StepUpdated
	step.StepID = "abcdef01"
	step.Action = "status_changed"
	step.PreviousStatus = "todo"
	step.Status = "skipped"
	step.ChangedFields = []string{"description", "title"}
	thread := common
	thread.Type = ThreadPosted
	thread.TaskVersion = 0
	thread.MessageID = messageID
	thread.CreatedAt = &at
	reply := replyID
	thread.ReplyTo = &reply
	cases := []struct {
		name string
		fact Fact
		want string
		sha  string
	}{
		{"created", created, `{"specversion":"1.0","id":"a0be4d96-fb33-41ba-a7bd-7885c1e94247","source":"urn:daynight:project:22222222-2222-4222-8222-222222222222","type":"cc.daynight.task.created.v1","subject":"tasks/33333333-3333-4333-8333-333333333333","time":"2026-11-06T08:00:00Z","datacontenttype":"application/json","data":{"projectId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","taskVersion":"42","status":"todo","paused":true}}`, "bce6715aa1da733672427d0f1a019fcb0b42f74df723099c20425ca2a822c768"},
		{"status_changed", status, `{"specversion":"1.0","id":"a0be4d96-fb33-41ba-a7bd-7885c1e94247","source":"urn:daynight:project:22222222-2222-4222-8222-222222222222","type":"cc.daynight.task.status_changed.v1","subject":"tasks/33333333-3333-4333-8333-333333333333","time":"2026-11-06T08:00:00Z","datacontenttype":"application/json","data":{"projectId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","taskVersion":"42","previousStatus":"done","status":"cancelled"}}`, "f6a53dcdf7166a2a29ae31fa354882830dd084af008b6413a4e744791ccf12e6"},
		{"paused", paused, `{"specversion":"1.0","id":"a0be4d96-fb33-41ba-a7bd-7885c1e94247","source":"urn:daynight:project:22222222-2222-4222-8222-222222222222","type":"cc.daynight.task.paused.v1","subject":"tasks/33333333-3333-4333-8333-333333333333","time":"2026-11-06T08:00:00Z","datacontenttype":"application/json","data":{"projectId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","taskVersion":"42","paused":true}}`, "fd61c53c96e50f769611cbd7221ca69730cdb01826e015a9744edcec2c5ecd4e"},
		{"deleted", deleted, `{"specversion":"1.0","id":"a0be4d96-fb33-41ba-a7bd-7885c1e94247","source":"urn:daynight:project:22222222-2222-4222-8222-222222222222","type":"cc.daynight.task.deleted.v1","subject":"tasks/33333333-3333-4333-8333-333333333333","time":"2026-11-06T08:00:00Z","datacontenttype":"application/json","data":{"projectId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","taskVersion":"42","deletedAt":"2026-11-06T08:00:00Z"}}`, "b8d3b8fddbadc02293918dac44c1eb83bbe531651e4a0a6f3b378ac5a9e42d6d"},
		{"step_updated", step, `{"specversion":"1.0","id":"a0be4d96-fb33-41ba-a7bd-7885c1e94247","source":"urn:daynight:project:22222222-2222-4222-8222-222222222222","type":"cc.daynight.task.step_updated.v1","subject":"tasks/33333333-3333-4333-8333-333333333333/steps","time":"2026-11-06T08:00:00Z","datacontenttype":"application/json","data":{"projectId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","taskVersion":"42","stepId":"abcdef01","action":"status_changed","fromPosition":null,"toPosition":null,"previousStatus":"todo","status":"skipped","changedFields":["description","title"]}}`, "2745e407c9403a94df6b442eb500c56ad4c75657d740f17d3659d9fb47b86da3"},
		{"thread_posted", thread, `{"specversion":"1.0","id":"a0be4d96-fb33-41ba-a7bd-7885c1e94247","source":"urn:daynight:project:22222222-2222-4222-8222-222222222222","type":"cc.daynight.task.thread_posted.v1","subject":"tasks/33333333-3333-4333-8333-333333333333/thread/44444444-4444-4444-8444-444444444444","time":"2026-11-06T08:00:00Z","datacontenttype":"application/json","data":{"projectId":"22222222-2222-4222-8222-222222222222","taskId":"33333333-3333-4333-8333-333333333333","messageId":"44444444-4444-4444-8444-444444444444","createdAt":"2026-11-06T08:00:00Z","position":{"createdAt":"2026-11-06T08:00:00Z","messageId":"44444444-4444-4444-8444-444444444444"},"replyTo":"55555555-5555-4555-8555-555555555555"}}`, "af106922f5a95feee20281d0307117813cc18e30621785bd8807530e397dbf60"},
	}
	schemaBytes, err := os.ReadFile("event.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schemaDoc any
	if err = json.Unmarshal(schemaBytes, &schemaDoc); err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err = compiler.AddResource("urn:daynight:webhook:event:v1", schemaDoc); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile("urn:daynight:webhook:event:v1")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := Render(eventID, tc.fact)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(raw, []byte(tc.want)) {
				t.Fatalf("wire bytes differ:\n got %s\nwant %s", raw, tc.want)
			}
			sum := sha256.Sum256(raw)
			if hex.EncodeToString(sum[:]) != tc.sha {
				t.Fatalf("hash: %x", sum)
			}
			var document any
			if err = json.Unmarshal(raw, &document); err != nil {
				t.Fatal(err)
			}
			if err = schema.Validate(document); err != nil {
				t.Fatal(err)
			}
			got, _, err := Decode(raw)
			if err != nil || got != eventID {
				t.Fatalf("decode id=%s: %v", got, err)
			}
		})
	}
}
