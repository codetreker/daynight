// Package sessionprotocol validates the shared Daynight session wire contract.
// Validation establishes message shape; callers still authorize the actor and
// compare the claim, execution generation and native interaction at dispatch.
package sessionprotocol

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
)

const Protocol = "daynight.session.v1"

var errInvalid = errors.New("invalid Daynight session protocol value")
var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var requestPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)
var sequencePattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

type Fence struct {
	TestExecutionID     string `json:"testExecutionId,omitempty"`
	SessionID           string `json:"sessionId"`
	ClaimID             string `json:"claimId,omitempty"`
	ExecutionGeneration string `json:"executionGeneration"`
}

type Command struct {
	Fence
	Protocol    string          `json:"protocol"`
	RequestID   string          `json:"requestId"`
	OperationID string          `json:"operationId"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload"`
}

type TextPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type SendMessage struct {
	Content        []TextPart `json:"content"`
	ExpectedTurnID *string    `json:"expectedTurnId"`
}

type Cancel struct {
	ExpectedTurnID string `json:"expectedTurnId"`
}

type InteractionResponse struct {
	InteractionID       string          `json:"interactionId"`
	InteractionRevision string          `json:"interactionRevision"`
	SubmissionID        string          `json:"submissionId"`
	Response            json.RawMessage `json:"response"`
}

// DecodeCommand rejects unknown fields, duplicate fields and unsupported
// actions. Decimal generations remain strings, including values above 2^53.
// Payload is validated according to the explicit operation kind.
func DecodeCommand(data []byte) (Command, error) {
	if !validUnicode(data) {
		return Command{}, errInvalid
	}
	binding := "claimId"
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	if _, ok := fields["testExecutionId"]; ok {
		binding = "testExecutionId"
	}
	_, err := object(data, "protocol", "requestId", "operationId", "sessionId", binding, "executionGeneration", "kind", "payload")
	if err != nil {
		return Command{}, err
	}
	var command Command
	if json.Unmarshal(data, &command) != nil || command.Protocol != Protocol || !requestPattern.MatchString(command.RequestID) || !uuidPattern.MatchString(command.OperationID) || !uuidPattern.MatchString(command.SessionID) || !(uuidPattern.MatchString(command.ClaimID) != uuidPattern.MatchString(command.TestExecutionID)) || !positiveSequence(command.ExecutionGeneration) {
		return Command{}, errInvalid
	}
	switch command.Kind {
	case "send_message":
		err = validateSend(command.Payload)
	case "cancel":
		var fields map[string]json.RawMessage
		fields, err = object(command.Payload, "expectedTurnId")
		if err == nil && !stringValue(fields["expectedTurnId"], false, 256) {
			err = errInvalid
		}
	case "interaction_response":
		err = validateInteraction(command.Payload)
	case "update_setting":
		if !validateObject(command.Payload, schema{"settingId": key, "value": func(raw json.RawMessage) bool { return stringValue(raw, false, 4096) }, "expectedControlsRevision": sequence}) {
			err = errInvalid
		}
	case "execute_command":
		if !validateObject(command.Payload, schema{"commandId": key, "arguments": func(raw json.RawMessage) bool { return stringValue(raw, true, maxTextBytes) }, "expectedControlsRevision": sequence, "expectedTurnId": optional(key)}) {
			err = errInvalid
		}
	case "refresh_controls":
		_, err = object(command.Payload)
	default:
		err = errInvalid
	}
	if err != nil {
		return Command{}, err
	}
	return command, nil
}

func positiveSequence(value string) bool {
	if !sequencePattern.MatchString(value) {
		return false
	}
	_, err := strconv.ParseInt(value, 10, 64)
	return err == nil
}

func validateSend(data []byte) error {
	fields, err := object(data, "content", "expectedTurnId")
	if err != nil {
		return err
	}
	if !nullableString(fields["expectedTurnId"], false, 256) {
		return errInvalid
	}
	parts, err := array(fields["content"])
	if err != nil || len(parts) == 0 {
		return errInvalid
	}
	for _, part := range parts {
		item, err := object(part, "type", "text")
		if err != nil || stringField(item["type"]) != "text" || !stringValue(item["text"], false, maxTextBytes) {
			return errInvalid
		}
	}
	return nil
}

func validateInteraction(data []byte) error {
	fields, err := object(data, "interactionId", "interactionRevision", "submissionId", "response")
	if err != nil {
		return err
	}
	if !uuidPattern.MatchString(stringField(fields["interactionId"])) || !uuidPattern.MatchString(stringField(fields["submissionId"])) || !positiveSequence(stringField(fields["interactionRevision"])) {
		return errInvalid
	}
	return validateResponse(fields["response"])
}

func validateResponse(data []byte) error {
	var discriminator struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(data, &discriminator) != nil {
		return errInvalid
	}
	switch discriminator.Kind {
	case "dismiss":
		_, err := object(data, "kind")
		return err
	case "approval":
		fields, err := object(data, "kind", "action")
		if err != nil {
			return err
		}
		switch stringField(fields["action"]) {
		case "allow_once", "allow_session", "reject":
			return nil
		}
	case "question":
		return validateAnswers(data)
	case "form":
		return validateForm(data)
	}
	return errInvalid
}

func validateAnswers(data []byte) error {
	fields, err := object(data, "kind", "answers")
	if err != nil {
		return err
	}
	answers, err := array(fields["answers"])
	if err != nil || len(answers) == 0 {
		return errInvalid
	}
	seen := map[string]bool{}
	for _, answer := range answers {
		item, err := object(answer, "questionId", "optionIds", "text")
		if err != nil || !uniqueKey(item["questionId"], seen) || !nullableString(item["text"], true, maxTextBytes) || !uniqueStrings(item["optionIds"]) {
			return errInvalid
		}
	}
	return nil
}

func validateForm(data []byte) error {
	fields, err := object(data, "kind", "values")
	if err != nil {
		return err
	}
	values, err := array(fields["values"])
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, value := range values {
		item, err := object(value, "fieldId", "value")
		if err != nil || !uniqueKey(item["fieldId"], seen) || !formValue(item["value"]) {
			return errInvalid
		}
	}
	return nil
}
