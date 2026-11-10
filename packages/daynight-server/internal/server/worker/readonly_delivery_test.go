package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

func TestReadOnlyHTTPDirectoryPagesAndOwnerRefusals(t *testing.T) {
	f := newRequestFixture(t)
	type target struct {
		token     string
		principal model.Principal
		worker    string
		fence     ro.Fence
		root      string
		names     [3]string
		cursors   [2]string
	}
	targets := []target{
		{token: "alpha-token", principal: model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "11111111-1111-4111-8111-222222222222"}, worker: "11111111-1111-4111-8111-333333333333", fence: ro.Fence{Protocol: ro.Protocol, OwnerUserID: "11111111-1111-4111-8111-111111111111", WorkerID: "11111111-1111-4111-8111-333333333333", ConnectionID: "11111111-1111-4111-8111-444444444444", CapabilityGeneration: "11111111-1111-4111-8111-555555555555"}, root: "/native/alpha", names: [3]string{"alpha-a", "alpha-b", "alpha-c"}, cursors: [2]string{"alpha-opaque-1", "alpha-opaque-2"}},
		{token: "beta-token", principal: model.Principal{Kind: model.PATCredential, UserID: "22222222-2222-4222-8222-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, worker: "22222222-2222-4222-8222-333333333333", fence: ro.Fence{Protocol: ro.Protocol, OwnerUserID: "22222222-2222-4222-8222-111111111111", WorkerID: "22222222-2222-4222-8222-333333333333", ConnectionID: "22222222-2222-4222-8222-444444444444", CapabilityGeneration: "22222222-2222-4222-8222-555555555555"}, root: "/native/beta", names: [3]string{"beta-a", "beta-b", "beta-c"}, cursors: [2]string{"beta-opaque-1", "beta-opaque-2"}},
	}
	requestInput := func(id string, cursor *string) ro.Request {
		input := `{"limit":1}`
		if cursor != nil {
			input = fmt.Sprintf(`{"limit":1,"cursor":%q}`, *cursor)
		}
		return ro.Request{RequestID: id, Operation: "directory.list", Input: json.RawMessage(input)}
	}
	for _, target := range targets {
		var cursor *string
		var names []string
		for page := 0; ; page++ {
			if page >= 10 {
				t.Fatal("directory did not terminate within ten pages")
			}
			if page >= len(target.names) {
				t.Fatalf("unexpected extra page for %s", target.root)
			}
			id := uuid.NewString()
			var declaredCursor *string
			if page > 0 {
				declaredCursor = &target.cursors[page-1]
			}
			var next *string
			if page < 2 {
				next = &target.cursors[page]
			}
			nextJSON := "null"
			if next != nil {
				nextJSON = fmt.Sprintf("%q", *next)
			}
			result := json.RawMessage(fmt.Sprintf(`{"path":%q,"parentPath":null,"entries":[{"name":%q,"path":%q}],"nextCursor":%s}`, target.root, target.names[page], target.root+"/"+target.names[page], nextJSON))
			expectedMessage := ro.Message{Fence: target.fence, Type: "result", RequestID: id}
			p := &requestPlan{token: target.token, principal: target.principal, worker: target.worker, input: requestInput(id, declaredCursor), result: ro.Message{Fence: target.fence, Type: "result", RequestID: id, Result: result}}
			status, _, body := f.request(p, requestInput(id, cursor))
			var message ro.Message
			if err := json.Unmarshal(body, &message); err != nil {
				t.Fatalf("decode: %v, body=%s", err, body)
			}
			var directory ro.DirectoryResult
			if err := json.Unmarshal(message.Result, &directory); err != nil {
				t.Fatalf("directory: %v", err)
			}
			message.Result = nil
			expectedDirectory := ro.DirectoryResult{Path: target.root, ParentPath: nil, Entries: []ro.DirectoryEntry{{Name: target.names[page], Path: target.root + "/" + target.names[page]}}, NextCursor: next}
			if status != http.StatusOK || !reflect.DeepEqual(message, expectedMessage) || !reflect.DeepEqual(directory, expectedDirectory) {
				t.Fatalf("page %d: status=%d message=%+v directory=%+v", page, status, message, directory)
			}
			names = append(names, directory.Entries[0].Name)
			cursor = directory.NextCursor
			if cursor == nil {
				break
			}
		}
		if !reflect.DeepEqual(names, target.names[:]) {
			t.Fatalf("names: %v", names)
		}
	}
	for i, target := range targets {
		caller := targets[1-i]
		input := requestInput(uuid.NewString(), nil)
		p := &requestPlan{token: caller.token, principal: caller.principal, worker: target.worker, input: input, err: &model.Fault{Code: "not_found", Message: "Worker not found."}}
		status, _, body := f.request(p, input)
		if status != http.StatusNotFound || bytes.Contains(body, []byte(target.root)) || !bytes.Contains(body, []byte(`"code":"not_found"`)) {
			t.Fatalf("cross-owner refusal: status=%d body=%s", status, body)
		}
	}
}

func TestReadOnlyHTTPNativeDirectoryEncoding(t *testing.T) {
	f := newRequestFixture(t)
	principal := model.Principal{Kind: model.PATCredential, UserID: "33333333-3333-4333-8333-111111111111", CredentialID: "33333333-3333-4333-8333-222222222222"}
	worker := "33333333-3333-4333-8333-333333333333"
	fence := ro.Fence{Protocol: ro.Protocol, OwnerUserID: principal.UserID, WorkerID: worker, ConnectionID: "33333333-3333-4333-8333-444444444444", CapabilityGeneration: "33333333-3333-4333-8333-555555555555"}
	parent := "/" + strings.Repeat("r", 107)
	cases := []struct{ name, characters string }{{"a", strings.Repeat("&", 240)}, {"b", strings.Repeat("<>", 120)}, {"c", strings.Repeat("\u2028\u2029", 40)}}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			path := parent + "/" + item.name
			entries := make([]string, 0, 100)
			for i := 0; i < 100; i++ {
				name := fmt.Sprintf("%03d%s", i, item.characters)
				entries = append(entries, `{"name":"`+name+`","path":"`+path+`/`+name+`"}`)
			}
			payload := json.RawMessage(`{"path":"` + path + `","parentPath":"` + parent + `","entries":[` + strings.Join(entries, ",") + `],"nextCursor":null}`)
			if len(payload) < 60<<10 || len(payload) > ro.MaxResultBytes {
				t.Fatalf("native result size=%d", len(payload))
			}
			id := uuid.NewString()
			input := ro.Request{RequestID: id, Operation: "directory.list", Input: json.RawMessage(fmt.Sprintf(`{"path":%q,"limit":100}`, path))}
			p := &requestPlan{token: "encoding-token", principal: principal, worker: worker, input: input, result: ro.Message{Fence: fence, Type: "result", RequestID: id, Result: payload}}
			status, _, wire := f.request(p, input)
			var message ro.Message
			if err := json.Unmarshal(wire, &message); err != nil {
				t.Fatalf("decode: %v", err)
			}
			var actual ro.DirectoryResult
			if err := json.Unmarshal(message.Result, &actual); err != nil {
				t.Fatalf("result: %v", err)
			}
			message.Result = nil
			expected := ro.DirectoryResult{Path: path, ParentPath: &parent, Entries: make([]ro.DirectoryEntry, 100), NextCursor: nil}
			for i := range expected.Entries {
				name := fmt.Sprintf("%03d%s", i, item.characters)
				expected.Entries[i] = ro.DirectoryEntry{Name: name, Path: path + "/" + name}
			}
			if status != http.StatusOK || len(wire) > ro.MaxWireBytes || !reflect.DeepEqual(message, ro.Message{Fence: fence, Type: "result", RequestID: id}) || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("encoding: status=%d wire=%d message=%+v entries=%d", status, len(wire), message, len(actual.Entries))
			}
			legacy := strings.NewReplacer("&", `\u0026`, "<", `\u003c`, ">", `\u003e`, "\u2028", `\u2028`, "\u2029", `\u2029`).Replace(string(wire))
			if (item.name == "a" || item.name == "b") && len(legacy) <= ro.MaxWireBytes {
				t.Fatalf("legacy escaping challenge: native=%d wire=%d legacy=%d", len(payload), len(wire), len(legacy))
			}
		})
	}
}
