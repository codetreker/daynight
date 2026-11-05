package e2e_tests

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

const acceptanceSQLRequestID = "AKY5C2XWJRHDIAO64EISZNSQLN"

func acceptanceErrorLeaks(body []byte, responseIDs []string) (bool, error) {
	diagnostics, err := acceptanceErrorDiagnostics(body, responseIDs)
	if err != nil {
		return false, err
	}
	return bytes.Contains(body, []byte("acceptance-secret")) || bytes.Contains(body, []byte("postgres://")) || bytes.Contains(diagnostics, []byte("SQL")), nil
}

func acceptanceErrorDiagnostics(body []byte, responseIDs []string) ([]byte, error) {
	if len(responseIDs) != 1 || len(responseIDs[0]) == 0 || len(responseIDs[0]) > 64 {
		return nil, errors.New("expected one nonempty request ID response header within 64 bytes")
	}
	for index, char := range []byte(responseIDs[0]) {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || index > 0 && (char == '.' || char == '_' || char == '-') {
			continue
		}
		return nil, errors.New("request ID response header has invalid characters")
	}
	envelope, err := acceptanceErrorObject(body)
	if err != nil {
		return nil, fmt.Errorf("error envelope: %w", err)
	}
	errorField, ok := envelope["error"]
	if !ok {
		return nil, errors.New("error envelope is missing error")
	}
	fields, err := acceptanceErrorObject(errorField.value)
	if err != nil {
		return nil, fmt.Errorf("error object: %w", err)
	}
	idField, ok := fields["requestId"]
	if !ok || len(idField.value) == 0 || idField.value[0] != '"' {
		return nil, errors.New("error object is missing a string requestId")
	}
	var requestID string
	if err := json.Unmarshal(idField.value, &requestID); err != nil {
		return nil, fmt.Errorf("error requestId: %w", err)
	}
	if requestID != responseIDs[0] {
		return nil, errors.New("error requestId differs from the response header")
	}

	// Request IDs are opaque correlation metadata. Only the verified direct
	// error.requestId value is excluded; original bytes preserve every diagnostic
	// key, unknown field and numeric value for the leak checks.
	start := errorField.offset + idField.offset
	end := start + len(idField.value)
	diagnostics := make([]byte, 0, len(body)-len(idField.value)+2)
	diagnostics = append(diagnostics, body[:start]...)
	diagnostics = append(diagnostics, '"', '"')
	diagnostics = append(diagnostics, body[end:]...)
	return diagnostics, nil
}

type acceptanceErrorField struct {
	value  json.RawMessage
	offset int
}

func acceptanceErrorObject(data []byte) (map[string]acceptanceErrorField, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if opening != json.Delim('{') {
		return nil, errors.New("expected an object")
	}
	fields := make(map[string]acceptanceErrorField)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("expected an object key")
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, errors.New("duplicate object key")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = acceptanceErrorField{value: value, offset: int(decoder.InputOffset()) - len(value)}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the object")
	}
	return fields, nil
}

func TestAcceptanceErrorLeaks(t *testing.T) {
	const refusal = `{"error":{"code":"invalid_input","message":"Cursor is invalid for this list.","requestId":"` + acceptanceSQLRequestID + `"}}`
	if !bytes.Contains([]byte(refusal), []byte("SQL")) {
		t.Fatal("counterexample no longer exercises the original whole-body SQL predicate")
	}
	tests := []struct {
		name string
		body string
		id   string
		leak bool
	}{
		{name: "opaque correlation ID", body: refusal, id: acceptanceSQLRequestID},
		{name: "SQL in code", body: strings.Replace(refusal, "invalid_input", acceptanceSQLRequestID, 1), id: acceptanceSQLRequestID, leak: true},
		{name: "SQL in message", body: strings.Replace(refusal, "Cursor is invalid for this list.", acceptanceSQLRequestID, 1), id: acceptanceSQLRequestID, leak: true},
		{name: "SQL in nested details", body: `{"error":{"code":"invalid_input","message":"refused","requestId":"` + acceptanceSQLRequestID + `","details":{"nested":[{"requestId":"` + acceptanceSQLRequestID + `"}]}}}`, id: acceptanceSQLRequestID, leak: true},
		{name: "SQL in unknown error field", body: `{"error":{"code":"invalid_input","message":"refused","requestId":"` + acceptanceSQLRequestID + `","unknown":"` + acceptanceSQLRequestID + `"}}`, id: acceptanceSQLRequestID, leak: true},
		{name: "SQL in unknown root field", body: `{"error":{"code":"invalid_input","message":"refused","requestId":"` + acceptanceSQLRequestID + `"},"unknown":"` + acceptanceSQLRequestID + `"}`, id: acceptanceSQLRequestID, leak: true},
		{name: "SQL in error key", body: `{"error":{"code":"invalid_input","message":"refused","requestId":"` + acceptanceSQLRequestID + `","SQL":null}}`, id: acceptanceSQLRequestID, leak: true},
		{name: "SQL in root key", body: `{"error":{"code":"invalid_input","message":"refused","requestId":"` + acceptanceSQLRequestID + `"},"SQL":null}`, id: acceptanceSQLRequestID, leak: true},
		{name: "SQL in nested key", body: `{"error":{"code":"invalid_input","message":"refused","requestId":"` + acceptanceSQLRequestID + `","details":{"nested":{"SQL":null}}}}`, id: acceptanceSQLRequestID, leak: true},
		{name: "secret in correlation ID", body: strings.Replace(refusal, acceptanceSQLRequestID, "acceptance-secret", 1), id: "acceptance-secret", leak: true},
		{name: "secret in root metadata", body: `{"error":{"requestId":"safe"},"requestId":"acceptance-secret"}`, id: "safe", leak: true},
		{name: "secret in nested details", body: `{"error":{"requestId":"safe","details":{"nested":["acceptance-secret"]}}}`, id: "safe", leak: true},
		{name: "database URL in root metadata", body: `{"error":{"requestId":"safe"},"requestId":"postgres://private"}`, id: "safe", leak: true},
		{name: "database URL in error metadata", body: `{"error":{"requestId":"safe","unknown":"postgres://private"}}`, id: "safe", leak: true},
		{name: "database URL in nested details", body: `{"error":{"requestId":"safe","details":{"nested":["postgres://private"]}}}`, id: "safe", leak: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			leak, err := acceptanceErrorLeaks([]byte(test.body), []string{test.id})
			if err != nil || leak != test.leak {
				t.Fatalf("leak = %t, error = %v; expected leak = %t", leak, err, test.leak)
			}
		})
	}
}

func TestAcceptanceErrorDiagnosticsPreservesEnvelope(t *testing.T) {
	body := []byte(` { "unknown" : 9007199254740993123456789, "error" : { "requestId" : "` + acceptanceSQLRequestID + `", "details" : {"number":1.2300000000000000000000001e+100,"requestId":"nested"}, "unknown" : [true,null] } } `)
	diagnostics, err := acceptanceErrorDiagnostics(body, []string{acceptanceSQLRequestID})
	if err != nil {
		t.Fatal(err)
	}
	expected := bytes.Replace(body, []byte(`"`+acceptanceSQLRequestID+`"`), []byte(`""`), 1)
	if !bytes.Equal(diagnostics, expected) {
		t.Fatal("diagnostic bytes changed beyond the direct correlation ID value")
	}
}

func TestAcceptanceErrorLeaksRejectsInvalidCorrelation(t *testing.T) {
	tests := []struct {
		name string
		body string
		ids  []string
	}{
		{name: "malformed JSON", body: `{"error":`, ids: []string{"safe"}},
		{name: "trailing JSON", body: `{"error":{"requestId":"safe"}} {}`, ids: []string{"safe"}},
		{name: "non-object root", body: `[]`, ids: []string{"safe"}},
		{name: "missing error", body: `{}`, ids: []string{"safe"}},
		{name: "null error", body: `{"error":null}`, ids: []string{"safe"}},
		{name: "missing request ID", body: `{"error":{}}`, ids: []string{"safe"}},
		{name: "null request ID", body: `{"error":{"requestId":null}}`, ids: []string{"safe"}},
		{name: "numeric request ID", body: `{"error":{"requestId":123}}`, ids: []string{"123"}},
		{name: "empty request ID", body: `{"error":{"requestId":""}}`, ids: []string{"safe"}},
		{name: "mismatched request ID", body: `{"error":{"requestId":"other"}}`, ids: []string{"safe"}},
		{name: "duplicate error", body: `{"error":{"requestId":"safe"},"error":{"requestId":"safe"}}`, ids: []string{"safe"}},
		{name: "duplicate request ID", body: `{"error":{"requestId":"safe","requestId":"safe"}}`, ids: []string{"safe"}},
		{name: "escaped duplicate request ID", body: `{"error":{"requestId":"safe","request\u0049d":"safe"}}`, ids: []string{"safe"}},
		{name: "missing response header", body: `{"error":{"requestId":"safe"}}`},
		{name: "empty response header", body: `{"error":{"requestId":""}}`, ids: []string{""}},
		{name: "duplicate response header", body: `{"error":{"requestId":"safe"}}`, ids: []string{"safe", "safe"}},
		{name: "invalid response header", body: `{"error":{"requestId":"bad id"}}`, ids: []string{"bad id"}},
		{name: "invalid first ID character", body: `{"error":{"requestId":"_safe"}}`, ids: []string{"_safe"}},
		{name: "overlong response header", body: `{"error":{"requestId":"` + strings.Repeat("a", 65) + `"}}`, ids: []string{strings.Repeat("a", 65)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := acceptanceErrorLeaks([]byte(test.body), test.ids); err == nil {
				t.Fatal("invalid correlation metadata was accepted")
			}
		})
	}
}
