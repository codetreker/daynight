package worker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

type deadlineResponseRecorder struct {
	*httptest.ResponseRecorder
	reads, writes []time.Time
}

func (r *deadlineResponseRecorder) SetReadDeadline(at time.Time) error {
	if !at.IsZero() {
		r.reads = append(r.reads, at)
	}
	return nil
}
func (r *deadlineResponseRecorder) SetWriteDeadline(at time.Time) error {
	if !at.IsZero() {
		r.writes = append(r.writes, at)
	}
	return nil
}

type delayedModelBody struct {
	io.Reader
	delayed bool
}

func (b *delayedModelBody) Read(p []byte) (int, error) {
	if !b.delayed {
		b.delayed = true
		time.Sleep(2 * time.Second)
	}
	return b.Reader.Read(p)
}
func TestReadOnlyHTTPDeadlinesIncludeBodyReading(t *testing.T) {
	for _, item := range []struct {
		operation, input string
		timeout          time.Duration
	}{{"directory.list", `{}`, 10 * time.Second}, {"model.list", `{"provider":"codex"}`, 30 * time.Second}} {
		t.Run(item.operation, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var observed time.Time
				broker := ro.New(func(ctx context.Context, _ model.Principal, _ string) error {
					observed, _ = ctx.Deadline()
					return &model.Fault{Code: "permission_denied", Message: "Denied"}
				})
				defer broker.Close()
				routes := NewReadOnlyRoutes(broker, nil, slog.Default())
				worker := uuid.NewString()
				raw, _ := json.Marshal(ro.Request{RequestID: uuid.NewString(), Operation: item.operation, Input: json.RawMessage(item.input)})
				request := httptest.NewRequest("POST", "/", &delayedModelBody{Reader: strings.NewReader(string(raw))})
				request.SetPathValue("workerId", worker)
				writer := &deadlineResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
				started := time.Now()
				routes.request(writer, request, model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.PATCredential})
				if !observed.Equal(started.Add(item.timeout)) {
					t.Fatalf("operation deadline %s, want %s after body reading", observed, started.Add(item.timeout))
				}
				if len(writer.reads) != 1 || !writer.reads[0].Equal(started.Add(5*time.Second)) {
					t.Fatal("body deadline changed")
				}
				if len(writer.writes) != 2 || !writer.writes[0].Equal(started.Add(35*time.Second)) || !writer.writes[1].Equal(started.Add(item.timeout+5*time.Second)) {
					t.Fatalf("write deadlines: %v", writer.writes)
				}
			})
		})
	}
}
