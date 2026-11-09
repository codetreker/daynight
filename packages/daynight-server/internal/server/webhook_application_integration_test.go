package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type webhookHTTPApplicationFixture struct {
	t           *testing.T
	cfg         config.Config
	store       *httpTestStore
	runtime     *Runtime
	cancel      context.CancelFunc
	done        chan error
	user, token string
}

func (f *webhookHTTPApplicationFixture) start() {
	f.t.Helper()
	client, err := service.NewIdentityClient(f.cfg)
	if err != nil {
		f.t.Fatal(err)
	}
	app := service.NewModules(f.cfg, f.store, func(context.Context) error { return nil }, attachmentTestFiles(f.t), client)
	// Routes consume the selected service. Process tests own OpenApp's worker and resource assembly.
	app.Webhooks = &webhookservice.Service{DB: f.store, ConfigurationExpansionAvailable: f.cfg.WebhookEnabled, DispatchEnabled: f.cfg.WebhookEnabled, Random: webhookHTTPRandom()}
	handler, err := New(app, f.cfg, testLogger())
	if err != nil {
		if cleanup := app.Close(context.Background()); cleanup != nil {
			f.t.Error(cleanup)
		}
		f.t.Fatal(err)
	}
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.ShutdownTimeout, testLogger(), handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		if cleanup := handler.Shutdown(context.Background()); cleanup != nil {
			f.t.Error(cleanup)
		}
		if cleanup := app.Close(context.Background()); cleanup != nil {
			f.t.Error(cleanup)
		}
		f.t.Fatal(err)
	}
	root, cancel := context.WithCancel(context.Background())
	f.runtime, f.cancel, f.done = runtime, cancel, make(chan error, 1)
	go func() { f.done <- runtime.Run(root) }()
}
func (f *webhookHTTPApplicationFixture) stop() {
	f.t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
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
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
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
	database := newHTTPTestStoreForPrincipal(t, principal)
	plans := &webhookHTTPPlans{t: t}
	database.ReadWebhookSnapshotCall = plans.read
	database.WriteWebhookCall = plans.write
	t.Cleanup(plans.verify)
	c := configuredTestConfig()
	c.ShutdownTimeout = 5 * time.Second
	f := &webhookHTTPApplicationFixture{t: t, cfg: c, store: database, user: principal.UserID, token: httpTestToken(principal.Kind)}
	t.Cleanup(f.stop)
	now := time.Now().UTC()
	owner := wm.Owner{Kind: "personal", ID: principal.UserID}
	project := "c3333333-3333-4333-8333-333333333333"
	endpoint := wm.Endpoint{ID: "11111111-1111-4111-9111-111111111111", Owner: owner, Name: "receiver", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://receiver.example", DestinationConfiguration: []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook"}}`), ActiveKeyID: "22222222-2222-4222-a222-222222222222", CreatedAt: now, UpdatedAt: now}
	key := wm.SigningKey{EndpointID: endpoint.ID, ID: endpoint.ActiveKeyID, Slot: "current", Secret: bytes.Repeat([]byte{0x33}, 32), CreatedAt: now}
	subscription := wm.Subscription{ID: "44444444-4444-4444-8444-444444444444", EndpointID: endpoint.ID, ProjectID: project, Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	binding := wm.Binding{ID: "55555555-5555-4555-9555-555555555555", SubscriptionID: subscription.ID, EventType: "task.created", CreatedAt: now}
	policy := wm.Policy{Version: 1, MaxAutomaticAttempts: 10, AutomaticWindowSeconds: 259200, MaxManualOperations: 3, PayloadRetentionSeconds: 604800, MetadataRetentionSeconds: 2592000, OperationRetentionSeconds: 2592000, OperationMaxAgeSeconds: 300, OperationFutureSkewSeconds: 60}
	scope := func(calls ...string) *webhookHTTPScope {
		return &webhookHTTPScope{t: t, want: calls, principal: principal, now: now, endpoint: endpoint, key: key, subscription: subscription, binding: binding, policy: policy}
	}
	create := func(operationID string) (string, wm.Operation) {
		name, enabled := "receiver", true
		issuedAt := now.Format(time.RFC3339Nano)
		data, err := json.Marshal(map[string]any{"operationId": operationID, "issuedAt": issuedAt, "expectedUserId": principal.UserID, "name": name, "enabled": enabled, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.example/hook"}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}})
		if err != nil {
			t.Fatal(err)
		}
		fingerprint, err := corewebhook.Fingerprint(corewebhook.Intent{OperationID: operationID, ActorID: principal.UserID, OwnerKind: owner.Kind, OwnerID: owner.ID, Kind: "endpoint.create", IssuedAt: issuedAt, Name: &name, Enabled: &enabled, Destination: &corewebhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created"}}}})
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		return string(data), wm.Operation{Owner: owner, ID: operationID, ActorID: principal.UserID, Kind: "endpoint.create", TargetID: endpoint.ID, IssuedAt: issuedAt, RequestSHA256: hex.EncodeToString(digest[:]), Fingerprint: fingerprint, Effect: "applied", ConfigVersion: 1, DestinationRevisionAfter: 1, RecordedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
	}
	planMutation := func(op wm.Operation, enabled bool) {
		plans.addRead(scope("Credential"))
		calls := []string{"Operation", "Credential", "Policy", "ObservedAt", "LockConfigurationSources", "Credential", "Credential", "ObservedAt"}
		if enabled {
			calls = append(calls, "ReadEligibility", "LockCredential", "ObservedAt", "PutEndpoint", "PutSubscription", "PutBinding", "DeleteSigningKeys", "PutSigningKey", "PutOperation")
		}
		write := scope(calls...)
		write.operation, write.operationMissing = op, true
		write.outcome = store.TransactionNotCommitted
		if enabled {
			write.outcome = store.TransactionCommitted
		}
		plans.addWrite(write)
		if enabled {
			read := scope("Credential", "Operation", "ObservedAt", "Endpoint", "SigningKeys", "ObservedAt", "Subscriptions", "ReadEligibility", "Bindings")
			read.operation = op
			plans.addRead(read)
		}
	}
	planEndpoint := func() {
		plans.addRead(scope("Credential", "Endpoint", "SigningKeys", "ObservedAt", "Subscriptions", "ReadEligibility", "Bindings"))
	}
	f.start()
	f.expect("GET", "/readyz", "", 200)
	plans.addRead(scope("Credential", "Policy"))
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
	plans.addRead(scope("Credential", "Endpoints"))
	empty := f.expect("GET", "/api/v1/me/webhooks", "", 200)
	if !bytes.Contains(empty, []byte(`"items":[]`)) {
		t.Fatalf("empty collection: %s", empty)
	}
	body, op := create("61111111-1111-4111-8111-111111111111")
	planMutation(op, false)
	reject := f.expect("POST", "/api/v1/me/webhooks", body, 503)
	if !bytes.Contains(reject, []byte(`"webhooks_unavailable"`)) {
		t.Fatalf("disabled error: %s", reject)
	}
	f.stop()
	f.cfg.WebhookEnabled = true
	f.start()
	body, op = create("62222222-2222-4222-8222-222222222222")
	planMutation(op, true)
	created := f.expect("POST", "/api/v1/me/webhooks", body, 201)
	var result struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err := json.Unmarshal(created, &result); err != nil || result.Endpoint.ID != endpoint.ID {
		t.Fatalf("endpoint response %s err=%v", created, err)
	}
	f.stop()
	f.cfg.WebhookEnabled = false
	f.start()
	f.expect("GET", "/readyz", "", 200)
	planEndpoint()
	f.expect("GET", "/api/v1/me/webhooks/"+endpoint.ID, "", 200)

	// SQL capture, recovery and disabled-worker polling are retained by their Store and process owners.
	eventID, taskID := "73333333-3333-4333-8333-333333333333", "74444444-4444-4444-8444-444444444444"
	rendered, err := protocol.Render(eventID, protocol.Fact{Type: protocol.Created, ProjectID: project, TaskID: taskID, TaskVersion: 1, Status: "todo", OccurredAt: now})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(rendered)
	version, title := int64(1), "captured during maintenance"
	match := store.WebhookCapturedMatch{SubscriptionID: subscription.ID, BindingID: binding.ID, ProjectID: project, EventType: "task.created", AuthorizationEpoch: 1}
	matchDigest, err := webhookservice.MatchDigest([]store.WebhookCapturedMatch{match})
	if err != nil {
		t.Fatal(err)
	}
	delivery := store.WebhookDelivery{ID: "75555555-5555-4555-8555-555555555555", EventID: eventID, EndpointID: endpoint.ID, EventType: "task.created", ProjectID: project, Owner: owner, OccurredAt: now, OriginalMatchCount: 1, OriginalMatchSHA256: matchDigest, DestinationRevision: 1, DestinationKind: "http", DestinationOrigin: endpoint.Origin, AdapterVersion: 1, DestinationConfiguration: append([]byte(nil), endpoint.DestinationConfiguration...), Body: rendered, BodySHA256: digest[:], OriginalBodyBytes: len(rendered), Generation: 1, State: "pending", ExpiresAt: now.Add(3 * 24 * time.Hour), AutomaticExpiresAt: now.Add(3 * 24 * time.Hour), PayloadExpiresAt: now.Add(7 * 24 * time.Hour)}
	sources := store.WebhookHistorySources{Event: store.WebhookCapturedEvent{ID: eventID, ProjectID: project, TaskID: taskID, EventType: "task.created", OccurredAt: now, FactBytes: rendered, FactSHA256: digest[:], TaskVersion: &version}, OriginalFactBytes: len(rendered), TaskTitle: &title, ProjectReadable: true, TaskPresent: true, Matches: []store.WebhookAdmissionMatch{{WebhookCapturedMatch: match, Continuous: true}}}
	planHistory := func(generation int64) {
		read := scope("Credential", "Endpoint", "ObservedAt", "HistoryDisclosure", "HistoryBatch", "HistoryMatches", "HistoryBatchAttempts", "Policy")
		read.delivery, read.sources = delivery, sources
		read.delivery.Generation = generation
		plans.addRead(read)
	}
	planHistory(1)
	history := f.expect("GET", "/api/v1/me/webhooks/"+endpoint.ID+"/deliveries", "", 200)
	if !bytes.Contains(history, []byte(delivery.ID)) {
		t.Fatalf("history missing captured delivery: %s", history)
	}
	body, op = create("63333333-3333-4333-8333-333333333333")
	planMutation(op, false)
	reject = f.expect("POST", "/api/v1/me/webhooks", body, 503)
	if !bytes.Contains(reject, []byte(`"webhooks_unavailable"`)) {
		t.Fatalf("maintenance create error: %s", reject)
	}
	planHistory(2)
	history = f.expect("GET", "/api/v1/me/webhooks/"+endpoint.ID+"/deliveries", "", 200)
	if !bytes.Contains(history, []byte(`"generation":"2"`)) || !bytes.Contains(history, []byte(`"state":"pending"`)) || !bytes.Contains(history, []byte(`"attemptCount":0`)) {
		t.Fatalf("recovered history response: %s", history)
	}
	f.stop()
	f.cfg.WebhookEnabled = true
	f.start()
	f.expect("GET", "/readyz", "", 200)
	planEndpoint()
	f.expect("GET", "/api/v1/me/webhooks/"+endpoint.ID, "", 200)
	f.stop()
}
