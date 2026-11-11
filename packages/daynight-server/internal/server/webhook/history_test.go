package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

const deliveryID = "55555555-5555-4555-8555-555555555555"

type historyFake struct {
	fakeService
	input         webhookservice.Redelivery
	deliveryQuery webhookservice.DeliveryQuery
	attemptQuery  webhookservice.AttemptQuery
}

func (s *historyFake) ListDeliveries(_ context.Context, _ model.Principal, _ Owner, _ string, q webhookservice.DeliveryQuery) (any, error) {
	s.calls++
	s.deliveryQuery = q
	return map[string]any{"items": []any{}}, s.err
}
func (s *historyFake) GetDelivery(_ context.Context, _ model.Principal, _ Owner, _, _ string) (any, error) {
	s.calls++
	return map[string]any{}, s.err
}
func (s *historyFake) ListAttempts(_ context.Context, _ model.Principal, _ Owner, _, _ string, q webhookservice.AttemptQuery) (any, error) {
	s.calls++
	s.attemptQuery = q
	return map[string]any{"items": []any{}}, s.err
}
func (s *historyFake) Payload(_ context.Context, _ model.Principal, _ Owner, _, _ string) (any, error) {
	s.calls++
	return map[string]any{}, s.err
}
func (s *historyFake) Redeliver(_ context.Context, _ model.Principal, _ Owner, _, _ string, m webhookservice.Redelivery) (webhookservice.Result, error) {
	s.calls++
	s.input = m
	return webhookservice.Result{Body: map[string]any{}}, s.err
}
func historyFixture(s *historyFake) http.Handler {
	mux := http.NewServeMux()
	(&Routes{service: s, auth: fakeAuth{}, logger: slog.New(slog.NewJSONHandler(io.Discard, nil))}).RegisterRoutes(mux)
	return mux
}

func TestHistoryRoutesValidateFiltersAndMethods(t *testing.T) {
	s := &historyFake{}
	h := historyFixture(s)
	base := "/api/v1/me/webhooks/" + endpointID + "/deliveries"
	for _, path := range []string{base + "?state=unknown", base + "?state=pending&state=failed", base + "?projectId=bad", base + "?from=2026-01-01T00:00:00%2B01:00", base + "?limit=0", base + "/" + deliveryID + "/attempts?generation=01", base + "/" + deliveryID + "/payload?x=1"} {
		w := request(h, "GET", path, "")
		if w.Code != 400 || s.calls != 0 {
			t.Fatalf("%s: %d calls %d", path, w.Code, s.calls)
		}
	}
	w := request(h, "GET", base+"?state=pending&limit=2", "")
	if w.Code != 200 || s.calls != 1 || s.deliveryQuery.State != "pending" || s.deliveryQuery.Limit != 2 {
		t.Fatalf("%d %#v", w.Code, s)
	}
	w = request(h, "POST", base+"/"+deliveryID+"/payload", "")
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
}
func TestRedeliveryWireIdentityAndDigest(t *testing.T) {
	s := &historyFake{}
	h := historyFixture(s)
	path := "/api/v1/me/webhooks/" + endpointID + "/deliveries/" + deliveryID + "/redeliveries"
	body := fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00.123400Z","expectedUserId":"%s","ifVersion":"9007199254740993","ifGeneration":"4"}`, operationID, userID)
	w := request(h, "POST", path, body)
	sum := sha256.Sum256([]byte(body))
	if w.Code != 202 || s.calls != 1 || s.input.IfVersion != 9007199254740993 || s.input.IfGeneration != 4 || s.input.RequestSHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("%d %#v", w.Code, s.input)
	}
	for _, bad := range []string{strings.Replace(body, `"ifGeneration":"4"`, `"generation":"4"`, 1), strings.Replace(body, `"ifGeneration":"4"`, `"ifGeneration":"04"`, 1), strings.Replace(body, `"ifVersion":"9007199254740993"`, `"ifVersion":4`, 1)} {
		w = request(h, "POST", path, bad)
		if w.Code != 400 || s.calls != 1 {
			t.Fatalf("%d calls %d", w.Code, s.calls)
		}
	}
	s.err = &model.Fault{Code: "delivery_busy"}
	w = request(h, "POST", path, body)
	if w.Code != 409 || code(t, w) != "delivery_busy" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestHistoryFailureRedactsDetails(t *testing.T) {
	var logs bytes.Buffer
	s := &historyFake{}
	s.err = fmt.Errorf("destination https://secret.invalid/private?token=credential and payload-marker and Authorization: bearer-value")
	mux := http.NewServeMux()
	(&Routes{service: s, auth: fakeAuth{}, logger: slog.New(slog.NewJSONHandler(&logs, nil))}).RegisterRoutes(mux)
	path := "/api/v1/me/webhooks/" + endpointID + "/deliveries/" + deliveryID + "/payload"
	w := request(mux, "GET", path, "")
	if w.Code != 500 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	for _, value := range []string{"secret.invalid", "private", "credential", "payload-marker", "bearer-value"} {
		if strings.Contains(w.Body.String(), value) || strings.Contains(logs.String(), value) {
			t.Fatalf("sensitive value appeared in output: %s", value)
		}
	}
	if !strings.Contains(logs.String(), userID) || !strings.Contains(logs.String(), endpointID) || !strings.Contains(logs.String(), deliveryID) || !strings.Contains(logs.String(), "internal_error") {
		t.Fatalf("missing safe correlation: %s", logs.String())
	}
}

type webhookMappingAuth struct{ principal model.Principal }

func (a webhookMappingAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Daynight-User-ID", a.principal.UserID)
		next(w, r, a.principal)
	}
}

type webhookMappingFixture struct {
	t         *testing.T
	principal model.Principal
	plans     *webhookHTTPPlans
	enabled   bool
	handler   http.Handler
}

func (f *webhookMappingFixture) start() {
	mux := http.NewServeMux()
	svc := &webhookservice.Service{DB: f.plans, ConfigurationExpansionAvailable: f.enabled, DispatchEnabled: f.enabled, Random: webhookHTTPRandom()}
	(&Routes{service: Adapter{Service: svc}, auth: webhookMappingAuth{f.principal}, logger: slog.New(slog.NewJSONHandler(io.Discard, nil))}).RegisterRoutes(mux)
	f.handler = mux
}
func (f *webhookMappingFixture) stop() { f.handler = nil }
func (f *webhookMappingFixture) expect(method, path, body string, status int) []byte {
	f.t.Helper()
	response := request(f.handler, method, path, body)
	if response.Code != status || response.Header().Get("Daynight-User-ID") != f.principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		f.t.Fatalf("%s %s: got %d want %d, headers %v: %s", method, path, response.Code, status, response.Header(), response.Body)
	}
	return response.Body.Bytes()
}

func TestWebhookMaintenanceMapping(t *testing.T) {
	principal := model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	plans := &webhookHTTPPlans{t: t}
	t.Cleanup(plans.verify)
	f := &webhookMappingFixture{t: t, principal: principal, plans: plans}
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
	f.enabled = true
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
	f.enabled = false
	f.start()
	planEndpoint()
	f.expect("GET", "/api/v1/me/webhooks/"+endpoint.ID, "", 200)

	// Generation is supplied by the read plan; recovery is verified by the physical recovery test.
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
		t.Fatalf("generation 2 history response: %s", history)
	}
	f.stop()
	f.enabled = true
	f.start()
	planEndpoint()
	f.expect("GET", "/api/v1/me/webhooks/"+endpoint.ID, "", 200)
	f.stop()
}
