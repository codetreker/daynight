package workerreadonly

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestProtocolRejectsUnboundedAndUnknownInputs(t *testing.T) {
	for _, input := range []string{`null`, `[]`, `{"path":null}`, `{"showHidden":null}`, `{"showHidden":"yes"}`, `{"limit":0}`, `{"limit":101}`, `{"limit":1.5}`, `{"unknown":true}`, `{"path":"bad\u0000path"}`, `{"filter":"` + strings.Repeat("x", 257) + `"}`, `{"path":"` + strings.Repeat("x", 4097) + `"}`, `{"cursor":"` + strings.Repeat("x", 4097) + `"}`, `{} {}`} {
		if err := ValidateRequest(Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(input)}); err == nil {
			t.Fatalf("accepted %s", input[:min(len(input), 80)])
		}
	}
	for _, input := range []string{`{}`, `{"path":"C:\\Users","filter":"","showHidden":true,"limit":100,"cursor":"cursor"}`} {
		if err := ValidateRequest(Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(input)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := ValidateRequest(Request{RequestID: "bad"}); err == nil {
		t.Fatal("bad id")
	}
	if err := Decode([]byte(strings.Repeat(" ", MaxWireBytes+1)), new(Hello)); err == nil {
		t.Fatal("unbounded input")
	}
	if err := ValidateHello(Hello{}); err == nil {
		t.Fatal("invalid hello")
	}
	if ErrorCode(errors.New("failure")) != "io_error" {
		t.Fatal("error mapping")
	}
}
func TestProtocolDirectoryResponseShapeAndLimits(t *testing.T) {
	valid := `{"path":"/","parentPath":null,"entries":[],"nextCursor":null}`
	m := Message{Type: "result", RequestID: uuid.NewString(), Result: json.RawMessage(valid)}
	if err := ValidateResult(m); err != nil {
		t.Fatal(err)
	}
	for _, result := range []string{`null`, `{}`, `{"path":"/","parentPath":null,"entries":null,"nextCursor":null}`, `{"path":"/","entries":[],"nextCursor":null}`, `{"path":"/","parentPath":null,"entries":[{"name":"","path":"/"}],"nextCursor":null}`, `{"path":"/","parentPath":null,"entries":[],"nextCursor":null,"extra":true}`} {
		m.Result = json.RawMessage(result)
		if err := ValidateResult(m); err == nil {
			t.Fatal("accepted bad directory response", result)
		}
	}
	m.Result = json.RawMessage(strings.Repeat(" ", MaxResultBytes+1))
	if err := ValidateResult(m); err == nil {
		t.Fatal("unbounded result")
	}
	m.Result = nil
	if err := ValidateResult(m); err == nil {
		t.Fatal("missing outcome")
	}
	m.Error = &Error{Code: "not_found", Message: "Not found"}
	if err := ValidateResult(m); err != nil {
		t.Fatal(err)
	}
	m.Error.Code = "bad"
	if err := ValidateResult(m); err == nil {
		t.Fatal("unknown error")
	}
	m.Error.Code = "not_found"
	m.Error.Message = ""
	if err := ValidateResult(m); err == nil {
		t.Fatal("empty message")
	}
	m.Error.Message = "Not found"
	m.Result = json.RawMessage(valid)
	if err := ValidateResult(m); err == nil {
		t.Fatal("conflicting outcomes")
	}
	m.Error = nil
	m.Type = "hello"
	if err := ValidateResult(m); err == nil {
		t.Fatal("wrong type")
	}
}
