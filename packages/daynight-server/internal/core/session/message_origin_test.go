package session

import (
	"bytes"
	"encoding/json"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestMessageOriginIsPartOfStableOperationIntent(t *testing.T) {
	for _, image := range []bool{false, true} {
		input := sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "same input"}}}
		if image {
			input.Content = append(input.Content, sp.TextPart{Type: "image", ImageID: uuid.NewString(), ResourceID: uuid.NewString()})
		}
		command := sp.Command{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, Protocol: sp.Protocol, RequestID: "origin", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(input)}
		legacyHash := commandHash(command)
		var payload map[string]any
		if err := json.Unmarshal(command.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		payload["origin"] = "user"
		command.Payload = encode(payload)
		if !bytes.Equal(commandHash(command), legacyHash) {
			t.Fatal("explicit user origin changed legacy operation identity")
		}
		payload["origin"] = "daynight"
		command.Payload = encode(payload)
		if bytes.Equal(commandHash(command), legacyHash) {
			t.Fatal("notification reused user operation identity")
		}
	}
}

func TestMessageOriginSurvivesPersistentIntentRecovery(t *testing.T) {
	input := sp.SendMessage{Origin: "daynight", Content: []sp.TextPart{{Type: "text", Text: "notification"}}}
	command := sp.Command{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, Protocol: sp.Protocol, RequestID: "origin", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(input)}
	d := &imageIntentDAO{}
	tx := &operationTx{dao: d, op: &Operation{}}
	if err := persistIntent(t.Context(), tx, command); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(d.raw, []byte(`"origin":"daynight"`)) {
		t.Fatal("persisted intent omitted origin")
	}
	recovered, available, err := persistedIntent(t.Context(), tx, command.SessionID, command.OperationID)
	if err != nil || !available {
		t.Fatal("intent recovery failed", available, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(recovered.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["origin"] != "daynight" || !bytes.Equal(commandHash(recovered), commandHash(command)) {
		t.Fatal("recovery changed notification identity", recovered)
	}
	if _, err := sp.DecodeCommand(encode(recovered)); err != nil {
		t.Fatal("recovered notification failed wire validation", err)
	}
}
