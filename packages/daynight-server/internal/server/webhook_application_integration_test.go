package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type webhookHTTPApplicationFixture struct {
	t           *testing.T
	cfg         config.Config
	operations  *webhookHTTPPlans
	principal   model.Principal
	runtime     *Runtime
	cancel      context.CancelFunc
	done        chan error
	client      *http.Client
	user, token string
}

func (f *webhookHTTPApplicationFixture) start() {
	f.t.Helper()
	var shutdown func(context.Context) error
	handler := newOperationHTTPServer(f.t, func(deps *httpDependencies) {
		deps.Ready = func(ctx context.Context) error {
			requireOperationHTTPContext(f.t, ctx)
			return nil
		}
		deps.Webhooks = webhookhttp.NewRoutes(f.operations, deps.Auth, testLogger())
		shutdown = func(ctx context.Context) error {
			deps.WorkerReadOnly.BeginShutdown()
			return errors.Join(deps.WorkerReadOnly.Shutdown(ctx), deps.Relay.Shutdown(ctx))
		}
	}, io.Discard, f.principal)
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.ShutdownTimeout, testLogger(), handler, shutdown, nil, nil, nil)
	if err != nil {
		ctx, cancel := context.WithTimeout(context.Background(), f.cfg.ShutdownTimeout)
		defer cancel()
		if closeErr := shutdown(ctx); closeErr != nil {
			f.t.Error(closeErr)
		}
		f.t.Fatal(err)
	}
	root, cancel := context.WithCancel(context.Background())
	f.runtime, f.cancel, f.done = runtime, cancel, make(chan error, 1)
	f.client = &http.Client{Timeout: 5 * time.Second, Transport: http.DefaultTransport.(*http.Transport).Clone()}
	go func() { f.done <- runtime.Run(root) }()
}
func (f *webhookHTTPApplicationFixture) stop() {
	f.t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
	f.client.CloseIdleConnections()
	select {
	case err := <-f.done:
		if err != nil {
			f.t.Errorf("runtime shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		f.t.Error("runtime shutdown timed out")
	}
	f.cancel = nil
}
func (f *webhookHTTPApplicationFixture) request(method, path, body string) (int, []byte) {
	f.t.Helper()
	req, err := http.NewRequest(method, "http://"+f.runtime.Address()+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: f.token})
	req.Header.Set("Origin", f.cfg.PublicOrigin)
	req.Header.Set("Content-Type", "application/json")
	response, err := f.client.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			f.t.Error(err)
		}
	}()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if path != "/readyz" && (response.Header.Get("Daynight-User-ID") != f.user || response.Header.Get("Cache-Control") != "no-store") {
		f.t.Fatalf("missing authentication headers: %v", response.Header)
	}
	return response.StatusCode, data
}
func (f *webhookHTTPApplicationFixture) expect(method, path, body string, status int) []byte {
	f.t.Helper()
	got, data := f.request(method, path, body)
	if got != status {
		f.t.Fatalf("%s %s: got %d want %d: %s", method, path, got, status, data)
	}
	return data
}

func TestWebhookProductionApplicationMaintenance(t *testing.T) {
	principal := defaultHTTPPrincipal()
	principal.Kind = model.SessionCredential
	plans := &webhookHTTPPlans{t: t, principal: principal}
	t.Cleanup(plans.verify)
	c := configuredTestConfig()
	c.ShutdownTimeout = 5 * time.Second
	f := &webhookHTTPApplicationFixture{t: t, cfg: c, operations: plans, principal: principal, user: principal.UserID, token: httpTestToken(principal.Kind)}
	t.Cleanup(f.stop)
	now := time.Now().UTC()
	owner := webhookhttp.Owner{Kind: "personal", ID: principal.UserID}
	project := "c3333333-3333-4333-8333-333333333333"
	endpointID := "11111111-1111-4111-9111-111111111111"
	create := func(operationID string) (string, webhookhttp.Mutation) {
		name, enabled := "receiver", true
		issuedAt := now.Format(time.RFC3339Nano)
		data, err := json.Marshal(map[string]any{"operationId": operationID, "issuedAt": issuedAt, "expectedUserId": principal.UserID, "name": name, "enabled": enabled, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.example/hook"}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}})
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		return string(data), webhookhttp.Mutation{Kind: "endpoint.create", OperationID: operationID, IssuedAt: issuedAt, ExpectedUserID: principal.UserID, RequestSHA256: hex.EncodeToString(digest[:]), Name: &name, Enabled: &enabled, Destination: &webhookhttp.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created"}}}}
	}
	planMutation := func(mutation webhookhttp.Mutation, enabled bool) {
		call := webhookHTTPCall{method: "Mutate", owner: owner, mutation: mutation}
		if enabled {
			call.body = webhookHTTPDocument(t, map[string]any{"operation": map[string]any{
				"operationId": mutation.OperationID, "kind": "endpoint.create", "issuedAt": mutation.IssuedAt,
				"requestSha256": mutation.RequestSHA256, "actorUserId": principal.UserID,
				"owner": map[string]any{"kind": "personal", "id": principal.UserID}, "endpointId": endpointID,
				"effect": "applied", "configVersionAfter": "1", "destinationRevisionAfter": "1",
				"deliveryId": nil, "generationAfter": nil, "keyId": nil, "overlapUntil": nil,
				"recordedAt": now, "expiresAt": now.Add(30 * 24 * time.Hour),
			}, "endpoint": webhookHTTPCurrentEndpoint(now, principal.UserID, project)})
		} else {
			call.err = &model.Fault{Code: "webhooks_unavailable", Message: "Webhook configuration expansion is unavailable."}
		}
		plans.add(call)
	}
	planEndpoint := func() {
		plans.add(webhookHTTPCall{method: "Get", owner: owner, endpoint: endpointID, body: webhookHTTPDocument(t, webhookHTTPCurrentEndpoint(now, principal.UserID, project))})
	}
	f.start()
	f.expect("GET", "/readyz", "", 200)
	catalogItems := []any{}
	for _, key := range []string{"task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"} {
		catalogItems = append(catalogItems, map[string]any{"key": key, "wireType": "cc.daynight." + key + ".v1", "schemaVersion": 1, "resourceKind": "project"})
	}
	plans.add(webhookHTTPCall{method: "Catalog", body: webhookHTTPDocument(t, map[string]any{
		"items": catalogItems, "service": map[string]any{"configurationExpansionAvailable": false, "dispatchEnabled": false},
		"limits": map[string]any{"policyVersion": "1", "requestBytes": 262144, "payloadBytes": 65536,
			"maxAutomaticAttempts": 10, "automaticWindowSeconds": 259200, "maxManualOperations": 3,
			"payloadRetentionSeconds": 604800, "operationMaxAgeSeconds": 300, "operationFutureSkewSeconds": 60},
	})})
	catalog := f.expect("GET", "/api/v1/webhook-event-types", "", 200)
	var catalogJSON struct {
		Items   []any `json:"items"`
		Service struct {
			Dispatch bool `json:"dispatchEnabled"`
		} `json:"service"`
	}
	if json.Unmarshal(catalog, &catalogJSON) != nil || len(catalogJSON.Items) != 6 || catalogJSON.Service.Dispatch {
		t.Fatalf("default catalog: %s", catalog)
	}
	plans.add(webhookHTTPCall{method: "List", owner: owner, list: webhookhttp.ListQuery{Limit: 50}, body: webhookHTTPDocument(t, map[string]any{"items": []any{}, "nextCursor": nil})})
	empty := f.expect("GET", "/api/v1/me/webhooks", "", 200)
	if !bytes.Contains(empty, []byte(`"items":[]`)) {
		t.Fatalf("empty collection: %s", empty)
	}
	body, mutation := create("61111111-1111-4111-8111-111111111111")
	planMutation(mutation, false)
	reject := f.expect("POST", "/api/v1/me/webhooks", body, 503)
	if !bytes.Contains(reject, []byte(`"webhooks_unavailable"`)) {
		t.Fatalf("disabled error: %s", reject)
	}
	f.stop()
	f.cfg.WebhookEnabled = true
	f.start()
	body, mutation = create("62222222-2222-4222-8222-222222222222")
	planMutation(mutation, true)
	created := f.expect("POST", "/api/v1/me/webhooks", body, 201)
	var result struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err := json.Unmarshal(created, &result); err != nil || result.Endpoint.ID != endpointID {
		t.Fatalf("endpoint response %s err=%v", created, err)
	}
	f.stop()
	f.cfg.WebhookEnabled = false
	f.start()
	f.expect("GET", "/readyz", "", 200)
	planEndpoint()
	f.expect("GET", "/api/v1/me/webhooks/"+endpointID, "", 200)

	planHistory := func(generation int64) {
		plans.add(webhookHTTPCall{method: "ListDeliveries", owner: owner, endpoint: endpointID,
			history: webhookservice.DeliveryQuery{Limit: 50}, body: webhookHTTPDocument(t, webhookHTTPCurrentHistory(now, principal.UserID, project, generation))})
	}
	planHistory(1)
	history := f.expect("GET", "/api/v1/me/webhooks/"+endpointID+"/deliveries", "", 200)
	if !bytes.Contains(history, []byte("75555555-5555-4555-8555-555555555555")) {
		t.Fatalf("history missing captured delivery: %s", history)
	}
	body, mutation = create("63333333-3333-4333-8333-333333333333")
	planMutation(mutation, false)
	reject = f.expect("POST", "/api/v1/me/webhooks", body, 503)
	if !bytes.Contains(reject, []byte(`"webhooks_unavailable"`)) {
		t.Fatalf("maintenance create error: %s", reject)
	}
	planHistory(2)
	history = f.expect("GET", "/api/v1/me/webhooks/"+endpointID+"/deliveries", "", 200)
	if !bytes.Contains(history, []byte(`"generation":"2"`)) || !bytes.Contains(history, []byte(`"state":"pending"`)) || !bytes.Contains(history, []byte(`"attemptCount":0`)) {
		t.Fatalf("recovered history response: %s", history)
	}
	f.stop()
	f.cfg.WebhookEnabled = true
	f.start()
	f.expect("GET", "/readyz", "", 200)
	planEndpoint()
	f.expect("GET", "/api/v1/me/webhooks/"+endpointID, "", 200)
	f.stop()
}

func webhookHTTPCurrentEndpoint(now time.Time, user, project string) map[string]any {
	return map[string]any{
		"id": "11111111-1111-4111-9111-111111111111", "owner": map[string]any{"kind": "personal", "id": user},
		"lifecycle": "active", "name": "receiver", "enabled": true, "configVersion": "1", "destinationRevision": "1",
		"destination":   map[string]any{"kind": "http", "adapterVersion": "1", "url": "https://receiver.example/hook", "displayUrl": "https://receiver.example/hook"},
		"signing":       map[string]any{"scheme": "standard-webhooks-v1", "activeKeyId": "22222222-2222-4222-a222-222222222222", "overlapUntil": nil},
		"subscriptions": []any{map[string]any{"id": "44444444-4444-4444-8444-444444444444", "projectId": project, "projectName": "maintenance", "eventTypes": []string{"task.created"}, "eligibility": "eligible"}},
		"capabilities":  map[string]any{"manage": true, "readSecret": true, "redeliver": true}, "createdAt": now, "updatedAt": now, "deletedAt": nil,
	}
}

func webhookHTTPCurrentHistory(now time.Time, user, project string, generation int64) map[string]any {
	return map[string]any{
		"items": []any{map[string]any{
			"id": "75555555-5555-4555-8555-555555555555", "endpointId": "11111111-1111-4111-9111-111111111111", "eventId": "73333333-3333-4333-8333-333333333333",
			"owner": map[string]any{"kind": "personal", "id": user}, "eventType": "task.created",
			"resource":   map[string]any{"projectId": project, "taskId": "74444444-4444-4444-8444-444444444444", "stepId": nil, "messageId": nil, "displayName": "captured during maintenance"},
			"occurredAt": now, "resourceVersion": "1", "target": map[string]any{"destinationRevision": "1", "url": "https://receiver.example/hook", "displayUrl": "https://receiver.example/hook"},
			"generation": strconv.FormatInt(generation, 10), "state": "pending", "attemptCount": 0, "automaticAttemptCount": 0, "manualOperationCount": 0,
			"nextAttemptAt": nil, "lastAttemptAt": nil, "expiresAt": now.Add(3 * 24 * time.Hour), "automaticExpiresAt": now.Add(3 * 24 * time.Hour), "payloadExpiresAt": now.Add(7 * 24 * time.Hour),
			"lastAcknowledgedAt": nil, "lastResult": nil, "payloadAvailable": true, "disclosure": "full",
		}},
		"nextCursor": nil, "historyMayBeIncomplete": true, "retention": map[string]any{"payloadRetentionSeconds": 604800, "metadataRetentionSeconds": 2592000},
	}
}
