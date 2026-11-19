package bot_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const botObservationPath = botDefinitionsPath + "/observation"

func (f *botDefinitionsFixture) Observation(ctx context.Context, principal model.Principal, id string) (botcore.Observation, error) {
	call := f.invoke(ctx, principal, "Observation", id, nil)
	if run, ok := call.result.(func(context.Context) (botcore.Observation, error)); ok {
		return run(ctx)
	}
	return botDefinitionResult[botcore.Observation](call)
}

func botObservationPointer[T any](value T) *T { return &value }

func TestBotObservationHTTPWire(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	instant := time.Date(2026, 11, 20, 14, 20, 15, 123000000, time.FixedZone("fixture", 8*60*60))
	value := botcore.Observation{BotID: botDefinitionsID, BotVersion: 9007199254740993, WorkerID: botDefinitionsWorker,
		Machine: &model.WorkerMachine{ID: "machine", Name: "新主机"}, Provider: "codex",
		SessionID: botObservationPointer("session"), TestExecutionID: botObservationPointer("execution"), NativeSessionID: botObservationPointer("native"),
		HostingGeneration: botObservationPointer(int64(9223372036854775807)), ExecutionGeneration: botObservationPointer("4"), ConnectionEpoch: botObservationPointer("8"),
		State: "working", Reason: "working", ObservedAt: instant, WorkerLastSeenAt: &instant, SessionLastSeenAt: &instant,
		FreshUntil: botObservationPointer(instant.Add(30 * time.Second)), CurrentTurnID: botObservationPointer("turn")}
	response := f.request(http.MethodGet, botObservationPath, "", &botDefinitionCall{method: "Observation", id: botDefinitionsID, result: value})
	got := decodeResponse[api.BotObservation](t, response, http.StatusOK)
	if got.SchemaVersion != 1 || got.BotID != value.BotID || got.BotVersion != value.BotVersion || got.WorkerID != value.WorkerID || got.Provider != value.Provider ||
		!reflect.DeepEqual(got.Machine, &api.WorkerMachine{ID: "machine", Name: "新主机"}) ||
		!reflect.DeepEqual(got.SessionID, value.SessionID) || !reflect.DeepEqual(got.TestExecutionID, value.TestExecutionID) || !reflect.DeepEqual(got.NativeSessionID, value.NativeSessionID) ||
		!reflect.DeepEqual(got.HostingGeneration, botObservationPointer("9223372036854775807")) || !reflect.DeepEqual(got.ExecutionGeneration, value.ExecutionGeneration) ||
		!reflect.DeepEqual(got.ConnectionEpoch, value.ConnectionEpoch) || !reflect.DeepEqual(got.CurrentTurnID, value.CurrentTurnID) || got.State != value.State || got.Reason != value.Reason ||
		!got.ObservedAt.Equal(instant) || got.WorkerLastSeenAt == nil || !got.WorkerLastSeenAt.Equal(instant) || got.SessionLastSeenAt == nil || !got.SessionLastSeenAt.Equal(instant) ||
		got.FreshUntil == nil || !got.FreshUntil.Equal(*value.FreshUntil) {
		t.Fatalf("observation: %s", response.Body)
	}
	if !strings.Contains(response.Body.String(), `"botVersion":"9007199254740993"`) || strings.Contains(response.Body.String(), "+08:00") || !strings.HasSuffix(response.Body.String(), "\n") {
		t.Fatalf("wire precision, UTC or newline: %s", response.Body)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 19 {
		t.Fatalf("unexpected fields: %s", response.Body)
	}
	for _, forbidden := range []string{"send", "operations", "controllerToken", "recoveryIdentity", "identityHash"} {
		if _, exists := fields[forbidden]; exists {
			t.Fatalf("exposed %s", forbidden)
		}
	}
}

func TestBotObservationHTTPUnknownIdentityAndLegacyShape(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	value := botcore.Observation{BotID: botDefinitionsID, BotVersion: 1, WorkerID: botDefinitionsWorker, Provider: "copilot", State: "connecting", Reason: "native_session_pending", ObservedAt: time.Now()}
	response := f.request(http.MethodGet, botObservationPath, "", &botDefinitionCall{method: "Observation", id: botDefinitionsID, result: value})
	got := decodeResponse[api.BotObservation](t, response, http.StatusOK)
	if got.NativeSessionID != nil || got.HostingGeneration != nil || got.Machine != nil || got.FreshUntil != nil || got.SessionID != nil {
		t.Fatalf("invented identity: %s", response.Body)
	}
	for _, field := range []string{"machine", "sessionId", "testExecutionId", "nativeSessionId", "hostingGeneration", "executionGeneration", "connectionEpoch", "workerLastSeenAt", "sessionLastSeenAt", "freshUntil", "currentTurnId"} {
		if !strings.Contains(response.Body.String(), `"`+field+`":null`) {
			t.Fatalf("missing explicit null %s: %s", field, response.Body)
		}
	}
	legacy := f.request(http.MethodGet, botDefinitionsPath, "", &botDefinitionCall{method: "Get", id: botDefinitionsID, result: model.Bot{ID: botDefinitionsID, WorkerID: botDefinitionsWorker, Version: 1}})
	decodeResponse[api.Bot](t, legacy, http.StatusOK)
	for _, field := range []string{"schemaVersion", "machine", "hostingGeneration", "nativeSessionId", "freshUntil", "state", "reason"} {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(legacy.Body.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
		if _, exists := fields[field]; exists {
			t.Fatalf("changed legacy Bot field %s: %s", field, legacy.Body)
		}
	}
	head := f.request(http.MethodHead, botObservationPath, "", &botDefinitionCall{method: "Observation", id: botDefinitionsID, result: value})
	if head.Code != http.StatusOK || head.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("HEAD: %d %s", head.Code, head.Body)
	}
}

func TestBotObservationHTTPRefusals(t *testing.T) {
	for _, path := range []string{botObservationPath + "?", botObservationPath + "?limit=1", botDefinitionsBase + "/invalid/observation"} {
		t.Run(path, func(t *testing.T) {
			f := newBotDefinitionsFixture(t, io.Discard)
			assertProjectError(t, f.request(http.MethodGet, path, "", nil), http.StatusBadRequest, "invalid_input")
		})
	}
	f := newBotDefinitionsFixture(t, io.Discard)
	response := f.request(http.MethodPost, botObservationPath, "", nil)
	assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
	if response.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("Allow: %v", response.Header())
	}
	for _, auth := range []botDefinitionAuthentication{botDefinitionAnonymous, botDefinitionRevoked} {
		assertProjectError(t, f.dispatch(http.MethodGet, botObservationPath, "", auth, nil), http.StatusUnauthorized, "unauthenticated")
	}
	for _, test := range []struct {
		code   string
		status int
	}{{"not_found", 404}, {"forbidden", 403}, {"service_unavailable", 503}, {"resource_conflict", 409}} {
		assertProjectError(t, f.request(http.MethodGet, botObservationPath, "", &botDefinitionCall{method: "Observation", id: botDefinitionsID, err: &model.Fault{Code: test.code, Message: "Observation refused."}}), test.status, test.code)
	}
}

func TestBotObservationHTTPCancellation(t *testing.T) {
	var logs bytes.Buffer
	f := newBotDefinitionsFixture(t, &logs)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	entered, exited := make(chan struct{}), make(chan struct{})
	f.want = &botDefinitionCall{method: "Observation", id: botDefinitionsID, result: func(got context.Context) (botcore.Observation, error) {
		close(entered)
		<-got.Done()
		if !errors.Is(got.Err(), context.Canceled) {
			t.Errorf("cancellation: %v", got.Err())
		}
		return botcore.Observation{}, got.Err()
	}}
	r := httptest.NewRequest(http.MethodGet, botObservationPath, nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+httpTestToken(f.principal.Kind))
	w := httptest.NewRecorder()
	go func() { defer close(exited); f.handler.ServeHTTP(w, r) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("observation did not start")
	}
	cancel()
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("observation did not stop")
	}
	if f.want != nil || f.authCalls != 1 || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled call or logs: pending=%v calls=%d logs=%s", f.want, f.authCalls, &logs)
	}
}

func TestBotObservationHTTPUnavailableImplementation(t *testing.T) {
	f := newBotExpiryFixture(t, defaultHTTPPrincipal())
	f.sourceContext = context.WithValue(t.Context(), botExpiryContextKey{}, "request")
	r := httptest.NewRequest(http.MethodGet, botObservationPath, nil).WithContext(f.sourceContext)
	r.Header.Set("Authorization", "Bearer "+httpTestToken(f.principal.Kind))
	r.Header.Set("X-Request-ID", "project-test")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	assertProjectError(t, w, http.StatusServiceUnavailable, "service_unavailable")
	if f.authCalls != 1 {
		t.Fatalf("credential calls: %d", f.authCalls)
	}
}
