//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

func serverAPIWorkerReadOnlyNormalFlow(t *testing.T, f *fixture) {
	workerID := uuid.NewString()
	base := "/api/v1/me/workers/" + workerID
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any {
		return map[string]any{"state": "ok", "checkedAt": stamp, "value": value}
	}
	report := map[string]any{
		"machine":  map[string]any{"id": uuid.NewString(), "name": "Readonly integration"},
		"platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":            probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":           probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory":        probe(map[string]any{"usedBytes": 4, "totalBytes": 8}),
		"disk":          probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions":      map[string]any{"daynight": "1.0.0", "herdr": probe("1.0.0"), "codex": probe("1.0.0"), "copilot": probe("1.0.0")},
		"taskInventory": nil,
	}
	requestJSON[map[string]any](t, f, http.MethodPost, base+"/report", report, http.StatusOK)

	ctx, cancel := context.WithTimeout(f.context, 5*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, strings.Replace(f.origin, "http:", "ws:", 1)+base+"/readonly/channel", &websocket.DialOptions{HTTPClient: f.client})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	if response.Header.Get("Daynight-User-ID") != f.userID {
		t.Fatal("readonly channel authenticated another owner")
	}
	write := func(message any) {
		t.Helper()
		encoded, err := json.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Write(ctx, websocket.MessageText, encoded); err != nil {
			t.Fatal(err)
		}
	}
	read := func() ro.Message {
		t.Helper()
		typeID, encoded, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var message ro.Message
		if err := ro.Decode(encoded, &message); err != nil || typeID != websocket.MessageText {
			t.Fatalf("readonly channel message: type=%v error=%v", typeID, err)
		}
		return message
	}
	hello := ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}}
	write(hello)
	ready := read()
	if ready.Type != "ready" || ready.Protocol != ro.Protocol || ready.OwnerUserID != f.userID || ready.WorkerID != workerID || ready.CapabilityGeneration != hello.CapabilityGeneration || ready.ConnectionID == "" {
		t.Fatalf("readonly ready identity differs: %+v", ready)
	}

	input := ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{"path":"/work"}`)}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.origin+base+"/readonly/requests", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	type answer struct {
		status int
		body   []byte
		err    error
	}
	answers := make(chan answer, 1)
	go func() {
		response, err := f.client.Do(request)
		if err != nil {
			answers <- answer{err: err}
			return
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, ro.MaxWireBytes+1))
		answers <- answer{status: response.StatusCode, body: body, err: errors.Join(readErr, response.Body.Close())}
	}()
	dispatched := read()
	if dispatched.Type != "request" || dispatched.Fence != ready.Fence || dispatched.RequestID != input.RequestID || dispatched.Operation != input.Operation || !bytes.Equal(dispatched.Input, input.Input) || dispatched.TimeoutMs <= 0 {
		t.Fatalf("readonly dispatch differs: %+v", dispatched)
	}
	result := ro.Message{Fence: ready.Fence, Type: "result", RequestID: input.RequestID, Result: json.RawMessage(`{"path":"/work","parentPath":"/","entries":[{"name":"project","path":"/work/project"}],"nextCursor":null}`)}
	write(result)
	select {
	case response := <-answers:
		if response.err != nil || response.status != http.StatusOK {
			t.Fatalf("readonly HTTP result: status=%d error=%v body=%s", response.status, response.err, response.body)
		}
		var actual ro.Message
		if err := ro.Decode(response.body, &actual); err != nil || !reflect.DeepEqual(actual, result) {
			t.Fatalf("readonly result differs: %+v error=%v", actual, err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
