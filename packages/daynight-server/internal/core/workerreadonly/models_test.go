package workerreadonly

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestModelDiscoveryRequestIsAdmitted(t *testing.T) {
	request := Request{RequestID: uuid.NewString(), Operation: "model.list", Input: json.RawMessage(`{"provider":"codex","cwd":"/workspace","model":"native-model","includeHidden":true,"limit":20,"cursor":"opaque"}`)}
	if err := ValidateRequest(request); err != nil {
		t.Fatal(err)
	}
	if err := ValidateHello(Hello{Type: "hello", Protocol: Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list", "model.list"}}); err != nil {
		t.Fatal(err)
	}
}

func modelResultFixture() json.RawMessage {
	return json.RawMessage(`{"schemaVersion":1,"provider":"codex","cwd":"/workspace","configurationGeneration":"` + strings.Repeat("a", 64) + `","catalogGeneration":"66666666-6666-4666-8666-666666666666","models":[{"id":"native-model","label":"Native Model","aliases":[],"hidden":false,"reasoningEfforts":["low","high"],"defaultReasoningEffort":"high"}],"defaults":{"model":{"value":"native-model","source":"native"},"reasoningEffort":{"value":"high","source":"native"}},"selectionError":null,"nextCursor":null}`)
}
func TestModelDiscoveryRejectsInvalidInputs(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{}`, `{"provider":null}`, `{"provider":"other"}`, `{"provider":"codex","cwd":"relative"}`, `{"provider":"codex","model":""}`, `{"provider":"codex","cursor":null}`, `{"provider":"codex","limit":0}`, `{"provider":"codex","limit":101}`, `{"provider":"codex","limit":1.5}`, `{"provider":"codex","includeHidden":null}`, `{"provider":"codex","includeHidden":"true"}`, `{"provider":"codex","extra":true}`, `{"provider":"codex","model":"\u0000"}`, `{"provider":"codex","model":"` + strings.Repeat("x", 257) + `"}`} {
		if err := ValidateRequest(Request{RequestID: uuid.NewString(), Operation: "model.list", Input: json.RawMessage(raw)}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, raw := range []string{`{"provider":"claude","cwd":"C:\\Users"}`, `{"provider":"copilot","cwd":"\\\\server\\share"}`, `{"provider":"codex"}`} {
		if err := ValidateRequest(Request{RequestID: uuid.NewString(), Operation: "model.list", Input: json.RawMessage(raw)}); err != nil {
			t.Fatal(err)
		}
	}
	for _, operations := range [][]string{nil, {"model.list", "model.list"}, {"shell"}, {"model.list", "directory.list", "shell"}} {
		if err := ValidateHello(Hello{Type: "hello", Protocol: Protocol, CapabilityGeneration: uuid.NewString(), Operations: operations}); err == nil {
			t.Fatal("accepted unsupported or duplicate operations")
		}
	}
}
func TestModelDiscoveryResultContract(t *testing.T) {
	valid := modelResultFixture()
	message := Message{Type: "result", RequestID: uuid.NewString(), Result: valid}
	if err := ValidateOperationResult(message, "model.list"); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(map[string]any){
		"missing default":        func(v map[string]any) { delete(v, "defaults") },
		"null models":            func(v map[string]any) { v["models"] = nil },
		"schema":                 func(v map[string]any) { v["schemaVersion"] = 2 },
		"provider":               func(v map[string]any) { v["provider"] = "other" },
		"cwd":                    func(v map[string]any) { v["cwd"] = "relative" },
		"config generation":      func(v map[string]any) { v["configurationGeneration"] = strings.Repeat("A", 64) },
		"catalog generation":     func(v map[string]any) { v["catalogGeneration"] = "invalid" },
		"cursor":                 func(v map[string]any) { v["nextCursor"] = "" },
		"too many models":        func(v map[string]any) { v["models"] = make([]any, 101) },
		"duplicates":             func(v map[string]any) { m := v["models"].([]any); v["models"] = append(m, m[0]) },
		"unknown field":          func(v map[string]any) { v["extra"] = true },
		"missing hidden":         func(v map[string]any) { delete(v["models"].([]any)[0].(map[string]any), "hidden") },
		"null aliases":           func(v map[string]any) { v["models"].([]any)[0].(map[string]any)["aliases"] = nil },
		"duplicate aliases":      func(v map[string]any) { v["models"].([]any)[0].(map[string]any)["aliases"] = []string{"x", "x"} },
		"too many aliases":       func(v map[string]any) { v["models"].([]any)[0].(map[string]any)["aliases"] = make([]string, 17) },
		"unknown effort default": func(v map[string]any) { v["models"].([]any)[0].(map[string]any)["defaultReasoningEffort"] = "other" },
		"empty id":               func(v map[string]any) { v["models"].([]any)[0].(map[string]any)["id"] = "" },
		"configured null": func(v map[string]any) {
			v["defaults"].(map[string]any)["model"] = map[string]any{"value": nil, "source": "local"}
		},
		"unknown value": func(v map[string]any) {
			v["defaults"].(map[string]any)["model"] = map[string]any{"value": "model", "source": "unknown"}
		},
		"bad source": func(v map[string]any) {
			v["defaults"].(map[string]any)["model"] = map[string]any{"value": "model", "source": "other"}
		},
		"bad default": func(v map[string]any) {
			v["defaults"].(map[string]any)["reasoningEffort"] = map[string]any{"value": "", "source": "explicit"}
		},
		"missing default value": func(v map[string]any) { delete(v["defaults"].(map[string]any)["model"].(map[string]any), "value") },
		"bad selection":         func(v map[string]any) { v["selectionError"] = map[string]any{"code": "other", "message": "Error"} },
		"empty selection":       func(v map[string]any) { v["selectionError"] = map[string]any{"code": "unknown_default", "message": ""} },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			var value map[string]any
			_ = json.Unmarshal(valid, &value)
			mutate(value)
			raw, _ := json.Marshal(value)
			message.Result = raw
			if err := ValidateOperationResult(message, "model.list"); err == nil {
				t.Fatal("accepted malformed model result")
			}
		})
	}
	for _, code := range []string{"invalid_input", "capability_error", "cleanup_unknown", "stale_configuration"} {
		if err := ValidateOperationResult(Message{Type: "result", RequestID: uuid.NewString(), Error: &Error{Code: code, Message: "Failed"}}, "model.list"); err != nil {
			t.Fatal(err)
		}
	}
	for _, efforts := range []any{nil, []string{}} {
		var value map[string]any
		_ = json.Unmarshal(valid, &value)
		option := value["models"].([]any)[0].(map[string]any)
		option["reasoningEfforts"] = efforts
		option["defaultReasoningEffort"] = nil
		value["defaults"] = map[string]any{"model": map[string]any{"value": nil, "source": "unknown"}, "reasoningEffort": map[string]any{"value": nil, "source": "native"}}
		value["selectionError"] = map[string]any{"code": "unknown_default", "message": "Native default is unknown."}
		raw, _ := json.Marshal(value)
		message.Result = raw
		if err := ValidateOperationResult(message, "model.list"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBrokerModelsRequireAdvertisedOperationAndMatchingProvider(t *testing.T) {
	b := New(func(context.Context, model.Principal, string) error { return nil })
	defer b.Close()
	p, worker := brokerPrincipal(), uuid.NewString()
	old, err := b.Connect(context.Background(), p, worker, brokerHello())
	if err != nil {
		t.Fatal(err)
	}
	input := Request{RequestID: uuid.NewString(), Operation: "model.list", Input: json.RawMessage(`{"provider":"codex"}`)}
	if _, err = b.Request(context.Background(), p, worker, input); ErrorCode(err) != "unsupported" {
		t.Fatalf("old Worker admitted model request: %v", err)
	}
	select {
	case <-old.Messages:
		t.Fatal("unsupported request dispatched")
	default:
	}
	hello := brokerHello()
	hello.Operations = append(hello.Operations, "model.list")
	c, err := b.Connect(context.Background(), p, worker, hello)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	answer := make(chan error, 1)
	go func() {
		got, e := b.Request(ctx, p, worker, input)
		if e == nil && string(got.Result) != string(modelResultFixture()) {
			e = fmt.Errorf("unexpected model result")
		}
		answer <- e
	}()
	request := receiveRequest(t, c)
	message := Message{Fence: request.Fence, Type: "result", RequestID: request.RequestID, Result: json.RawMessage(`{"path":"/","parentPath":null,"entries":[],"nextCursor":null}`)}
	if err = b.Deliver(ctx, c, message); err == nil {
		t.Fatal("accepted directory shape for model request")
	}
	message.Result = json.RawMessage(strings.Replace(string(modelResultFixture()), `"provider":"codex"`, `"provider":"claude"`, 1))
	if err = b.Deliver(ctx, c, message); err == nil {
		t.Fatal("accepted another Provider")
	}
	message.Result = modelResultFixture()
	if err = b.Deliver(ctx, c, message); err != nil {
		t.Fatal(err)
	}
	if err = <-answer; err != nil {
		t.Fatal(err)
	}
}

func TestBrokerReadOperationsHaveIndependentDeadlines(t *testing.T) {
	for _, item := range []struct {
		operation, input string
		timeout          time.Duration
	}{{"directory.list", `{}`, 10 * time.Second}, {"model.list", `{"provider":"codex"}`, 30 * time.Second}} {
		t.Run(item.operation, func(t *testing.T) {
			var deadline time.Time
			b := New(func(ctx context.Context, _ model.Principal, _ string) error { deadline, _ = ctx.Deadline(); return nil })
			defer b.Close()
			p, worker := brokerPrincipal(), uuid.NewString()
			hello := brokerHello()
			hello.Operations = []string{item.operation}
			c, err := b.Connect(context.Background(), p, worker, hello)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			answer := make(chan error, 1)
			go func() {
				_, err := b.Request(ctx, p, worker, Request{RequestID: uuid.NewString(), Operation: item.operation, Input: json.RawMessage(item.input)})
				answer <- err
			}()
			request := receiveRequest(t, c)
			remaining := time.Until(deadline)
			if remaining < item.timeout-time.Second || remaining > item.timeout || request.TimeoutMs != int(item.timeout/time.Millisecond) {
				t.Errorf("deadline=%s wire=%d, want %s", remaining, request.TimeoutMs, item.timeout)
			}
			cancel()
			if err := <-answer; ErrorCode(err) != "cancelled" {
				t.Fatal(err)
			}
		})
	}
}
