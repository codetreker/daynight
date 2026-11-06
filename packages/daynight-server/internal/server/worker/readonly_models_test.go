package worker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

func readOnlyModelFixture() json.RawMessage {
	return json.RawMessage(`{"schemaVersion":1,"provider":"codex","cwd":"/workspace","configurationGeneration":"` + strings.Repeat("a", 64) + `","catalogGeneration":"66666666-6666-4666-8666-666666666666","models":[{"id":"native-model","label":"Native <Model> & 能力","aliases":[],"hidden":false,"reasoningEfforts":["low","high"],"defaultReasoningEffort":"high"}],"defaults":{"model":{"value":"native-model","source":"native"},"reasoningEffort":{"value":"high","source":"native"}},"selectionError":null,"nextCursor":null}`)
}
func TestReadOnlyHTTPModelDiscoveryPreservesCapabilitiesAndBinding(t *testing.T) {
	f := newReadOnlyFixture(t)
	c, ready := f.connect(t, f.worker, f.token, "directory.list", "model.list")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	input := ro.Request{RequestID: uuid.NewString(), Operation: "model.list", Input: json.RawMessage(`{"provider":"codex","limit":10}`)}
	answer := make(chan *http.Response, 1)
	failure := make(chan error, 1)
	go func() {
		response, err := f.request(ctx, f.worker, f.token, input)
		if err != nil {
			failure <- err
			return
		}
		answer <- response
	}()
	request := readOnlyRead(t, c)
	if request.Operation != "model.list" || string(request.Input) != string(input.Input) || request.Fence != ready.Fence {
		t.Fatal("model request lost its target binding")
	}
	readOnlySend(t, c, ro.Message{Fence: request.Fence, Type: "result", RequestID: request.RequestID, Result: readOnlyModelFixture()})
	select {
	case err := <-failure:
		t.Fatal(err)
	case response := <-answer:
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 {
			t.Fatalf("model result: %d %s", response.StatusCode, raw)
		}
		var result ro.Message
		if err = ro.Decode(raw, &result); err != nil {
			t.Fatal(err)
		}
		if result.Fence != ready.Fence || result.RequestID != input.RequestID {
			t.Fatal("HTTP result lost its request binding")
		}
		if err = ro.ValidateOperationResult(result, "model.list"); err != nil {
			t.Fatal(err)
		}
		var capabilities ro.ModelResult
		_ = json.Unmarshal(result.Result, &capabilities)
		if capabilities.Models[0].Label != "Native <Model> & 能力" || capabilities.Defaults.Model.Value == nil || *capabilities.Defaults.Model.Value != "native-model" {
			t.Fatal("native capability content changed")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
func TestReadOnlyHTTPDirectoryOnlyWorkerRejectsModelDiscovery(t *testing.T) {
	f := newReadOnlyFixture(t)
	f.connect(t, f.worker, f.token)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	response, err := f.request(ctx, f.worker, f.token, ro.Request{RequestID: uuid.NewString(), Operation: "model.list", Input: json.RawMessage(`{"provider":"codex"}`)})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotImplemented {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("old Worker status: %d %s", response.StatusCode, raw)
	}
}
func TestReadOnlyModelJSONRejectsMismatchedOperation(t *testing.T) {
	message := ro.Message{Type: "result", RequestID: uuid.NewString(), Result: readOnlyModelFixture()}
	if _, err := readOnlyResultJSON(message, "directory.list"); err == nil {
		t.Fatal("model content accepted as directory content")
	}
	if _, err := readOnlyResultJSON(message, "model.list"); err != nil {
		t.Fatal(err)
	}
}
