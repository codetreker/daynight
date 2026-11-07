package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

func TestReadOnlyCallerRevocationPreservesSharedChannel(t *testing.T) {
	f := newReadOnlyFixture(t)
	c, ready := f.connect(t, f.worker, f.token)
	validCookie := f.harness.Login(t, "readonly-owner")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type answer struct {
		status int
		body   []byte
		err    error
	}
	start := func(cookie *http.Cookie) <-chan answer {
		answers := make(chan answer, 1)
		go func() {
			raw, _ := json.Marshal(ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)})
			r, _ := http.NewRequestWithContext(ctx, "POST", f.server.URL+"/api/v1/me/workers/"+f.worker+"/readonly/requests", bytes.NewReader(raw))
			r.AddCookie(cookie)
			r.Header.Set("Origin", f.harness.Auth.Origin())
			response, err := http.DefaultClient.Do(r)
			if err != nil {
				answers <- answer{err: err}
				return
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			answers <- answer{status: response.StatusCode, body: body, err: err}
		}()
		return answers
	}
	revoked := start(f.cookie)
	first := readOnlyRead(t, c)
	valid := start(validCookie)
	second := readOnlyRead(t, c)
	if err := f.harness.Identity.Logout(ctx, f.owner); err != nil {
		t.Fatal(err)
	}
	readOnlySend(t, c, ro.Message{Fence: first.Fence, Type: "result", RequestID: first.RequestID, Result: json.RawMessage(`{"path":"/","parentPath":null,"entries":[],"nextCursor":null}`)})
	if got := <-revoked; got.err != nil || got.status != http.StatusUnauthorized {
		t.Fatalf("revoked caller: %+v", got)
	}
	readOnlySend(t, c, ro.Message{Fence: second.Fence, Type: "result", RequestID: second.RequestID, Result: json.RawMessage(`{"path":"/","parentPath":null,"entries":[],"nextCursor":null}`)})
	got := <-valid
	var result ro.Message
	if err := json.Unmarshal(got.body, &result); err != nil || got.err != nil || got.status != http.StatusOK || result.Fence != ready.Fence || result.RequestID != second.RequestID {
		t.Fatalf("valid pending caller lost shared channel: status=%d body=%s err=%v decode=%v", got.status, got.body, got.err, err)
	}
	// The same socket must also admit new work after the revoked response.
	next := start(validCookie)
	third := readOnlyRead(t, c)
	readOnlySend(t, c, ro.Message{Fence: third.Fence, Type: "result", RequestID: third.RequestID, Error: &ro.Error{Code: "not_found", Message: "Missing directory."}})
	if got := <-next; got.err != nil || got.status != http.StatusOK {
		t.Fatalf("next caller: %+v", got)
	}
}

func TestReadOnlyHTTPPreservesBoundedDirectoryJSON(t *testing.T) {
	for _, name := range []string{strings.Repeat("&", 310), strings.Repeat("<>&", 103), strings.Repeat("\u2028\u2029", 51)} {
		t.Run(name[:3], func(t *testing.T) {
			f := newReadOnlyFixture(t)
			c, _ := f.connect(t, f.worker, f.token)
			// These are literal UTF-8 bytes, as emitted by JSON.stringify in the Worker.
			entry := `{"name":"` + name + `","path":"/` + name + `"}`
			payload := []byte(`{"path":"/","parentPath":null,"entries":[` + strings.TrimSuffix(strings.Repeat(entry+",", 100), ",") + `],"nextCursor":null}`)
			if len(payload) < 60<<10 || len(payload) > ro.MaxResultBytes {
				t.Fatalf("fixture size: %d", len(payload))
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			responses := make(chan *http.Response, 1)
			failures := make(chan error, 1)
			go func() {
				response, err := f.request(ctx, f.worker, f.token, ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)})
				responses <- response
				failures <- err
			}()
			m := readOnlyRead(t, c)
			m.Type, m.Input, m.Operation, m.TimeoutMs, m.Result = "result", nil, "", 0, payload
			if err := ro.ValidateResult(m); err != nil {
				t.Fatal(err)
			}
			m.Result = nil
			envelope, _ := json.Marshal(m)
			wire := append(envelope[:len(envelope)-1], []byte(`,"result":`)...)
			wire = append(wire, payload...)
			wire = append(wire, '}')
			if err := c.Write(ctx, websocket.MessageText, wire); err != nil {
				t.Fatal(err)
			}
			response := <-responses
			if err := <-failures; err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			raw, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			var got ro.Message
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			var expected, actual ro.DirectoryResult
			if err := json.Unmarshal(payload, &expected); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(got.Result, &actual); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK || len(raw) > ro.MaxWireBytes || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("bounded JSON changed in transit: status=%d result=%d original=%d envelope=%d", response.StatusCode, len(got.Result), len(payload), len(raw))
			}
		})
	}
}

func TestReadOnlyResultJSONRejectsInvalidAndOversizedMessages(t *testing.T) {
	message := ro.Message{Type: "result", RequestID: uuid.NewString(), Result: json.RawMessage(`{"path":"/","parentPath":null,"entries":[],"nextCursor":null}`)}
	for _, result := range []json.RawMessage{json.RawMessage(`{`), json.RawMessage(strings.Repeat(" ", ro.MaxResultBytes+1))} {
		invalid := message
		invalid.Result = result
		if raw, err := readOnlyResultJSON(invalid, "directory.list"); err == nil || raw != nil {
			t.Fatal("invalid directory payload was encoded")
		}
	}
	message.OwnerUserID = strings.Repeat("a", ro.MaxWireBytes)
	if raw, err := readOnlyResultJSON(message, "directory.list"); err == nil || raw != nil {
		t.Fatal("oversized response envelope was encoded")
	}
}
