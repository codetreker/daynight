package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

const userID = "11111111-1111-4111-8111-111111111111"
const teamID = "22222222-2222-4222-8222-222222222222"
const endpointID = "33333333-3333-4333-8333-333333333333"
const operationID = "44444444-4444-4444-8444-444444444444"

type fakeAuth struct{}

func (fakeAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Daynight-User-ID", userID)
		next(w, r, model.Principal{UserID: userID})
	}
}

type fakeService struct {
	calls    int
	owner    Owner
	input    Mutation
	query    ListQuery
	id, read string
	replay   bool
	err      error
}

func (s *fakeService) Catalog(_ context.Context, _ model.Principal) (any, error) {
	s.calls++
	return map[string]any{"items": []any{}, "service": map[string]any{}, "limits": map[string]any{}}, s.err
}
func (s *fakeService) List(_ context.Context, _ model.Principal, o Owner, q ListQuery) (any, error) {
	s.calls++
	s.owner = o
	s.query = q
	return map[string]any{"items": []any{}, "nextCursor": nil}, s.err
}
func (s *fakeService) Get(_ context.Context, _ model.Principal, o Owner, id string) (any, error) {
	s.calls++
	s.owner = o
	s.id = id
	s.read = "get"
	return map[string]string{"id": id}, s.err
}
func (s *fakeService) Operation(_ context.Context, _ model.Principal, o Owner, id string) (any, error) {
	s.calls++
	s.owner = o
	s.id = id
	s.read = "operation"
	return map[string]string{"operationId": id}, s.err
}
func (s *fakeService) Secret(_ context.Context, _ model.Principal, o Owner, id string) (any, error) {
	s.calls++
	s.owner = o
	s.id = id
	s.read = "secret"
	return map[string]string{"endpointId": id}, s.err
}
func (s *fakeService) Mutate(_ context.Context, _ model.Principal, o Owner, m Mutation) (MutationResult, error) {
	s.calls++
	s.owner = o
	s.input = m
	return MutationResult{Body: map[string]string{"operationId": m.OperationID}, Replay: s.replay}, s.err
}
func fixture(s *fakeService, logs io.Writer) http.Handler {
	mux := http.NewServeMux()
	(&Routes{service: s, auth: fakeAuth{}, logger: slog.New(slog.NewJSONHandler(logs, nil))}).RegisterRoutes(mux)
	return mux
}
func request(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func createBody(url string) string {
	return fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00.123400Z","expectedUserId":"%s","name":"  Example  ","enabled":true,"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":%q}},"subscriptions":[]}`, operationID, userID, url)
}
func code(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var v struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v.Error.Code
}

func TestCreatePreservesOriginalDigestAndNormalizesInput(t *testing.T) {
	s := &fakeService{}
	h := fixture(s, io.Discard)
	body := createBody("https://example.test/Path?Secret=Value")
	w := request(h, "POST", "/api/v1/teams/"+teamID+"/webhooks", body)
	if w.Code != 201 || s.calls != 1 || s.owner != (Owner{Kind: "team", ID: teamID}) {
		t.Fatalf("response %d, service %#v", w.Code, s)
	}
	sum := sha256.Sum256([]byte(body))
	if s.input.RequestSHA256 != hex.EncodeToString(sum[:]) || s.input.IssuedAt != "2026-11-07T08:00:00.123400Z" || *s.input.Name != "Example" || s.input.Destination.URL != "https://example.test/Path?Secret=Value" || !s.input.HasSubscriptions {
		t.Fatalf("input %#v", s.input)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID {
		t.Fatal(w.Header())
	}
	s.replay = true
	w = request(h, "POST", "/api/v1/me/webhooks", body)
	if w.Code != 200 || s.owner != (Owner{Kind: "personal", ID: userID}) {
		t.Fatalf("replay %d owner %#v", w.Code, s.owner)
	}
}

func TestWritesRejectMalformedInputsBeforeService(t *testing.T) {
	good := createBody("https://example.test/Path")
	tests := []struct {
		name, body, media string
		status            int
		code              string
	}{
		{"duplicate", strings.Replace(good, `"enabled":true`, `"enabled":true,"enabled":false`, 1), "application/json", 400, "invalid_input"},
		{"unknown nested", strings.Replace(good, `"url":`, `"extra":1,"url":`, 1), "application/json", 400, "invalid_input"},
		{"surrogate", strings.Replace(good, "Example", `\ud800`, 1), "application/json", 400, "invalid_input"},
		{"invalid utf8", strings.Replace(good, "Example", string([]byte{0xff}), 1), "application/json", 400, "invalid_input"},
		{"null", strings.Replace(good, `"subscriptions":[]`, `"subscriptions":null`, 1), "application/json", 400, "invalid_input"},
		{"nonempty", strings.Replace(good, `"subscriptions":[]`, `"subscriptions":[{}]`, 1), "application/json", 400, "invalid_input"},
		{"missing subscriptions", strings.Replace(good, `,"subscriptions":[]`, "", 1), "application/json", 400, "invalid_input"},
		{"userinfo", createBody("https://secret@example.test/"), "application/json", 400, "invalid_input"},
		{"fragment", createBody("https://example.test/#secret"), "application/json", 400, "invalid_input"},
		{"identity", strings.Replace(good, userID, teamID, 1), "application/json", 409, "identity_mismatch"},
		{"media", good, "text/plain", 400, "invalid_input"},
		{"oversize", good + strings.Repeat(" ", maxBody), "application/json", 413, "content_too_large"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := &fakeService{}
			h := fixture(s, io.Discard)
			r := httptest.NewRequest("POST", "/api/v1/me/webhooks", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.media)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || code(t, w) != tc.code || s.calls != 0 {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body, s.calls)
			}
		})
	}
}

func TestRequestBodyExactByteLimit(t *testing.T) {
	s := &fakeService{}
	h := fixture(s, io.Discard)
	body := createBody("https://example.test/Path")
	body += strings.Repeat(" ", maxBody-len(body))
	w := request(h, "POST", "/api/v1/me/webhooks", body)
	if w.Code != http.StatusCreated || s.calls != 1 {
		t.Fatalf("exact limit: status=%d calls=%d body=%s", w.Code, s.calls, w.Body)
	}
	w = request(h, "POST", "/api/v1/me/webhooks", body+" ")
	if w.Code != http.StatusRequestEntityTooLarge || code(t, w) != "content_too_large" || s.calls != 1 {
		t.Fatalf("one byte over: status=%d calls=%d body=%s", w.Code, s.calls, w.Body)
	}
}

func TestCatalogRouting(t *testing.T) {
	s := &fakeService{}
	h := fixture(s, io.Discard)
	w := request(h, "GET", "/api/v1/webhook-event-types", "")
	if w.Code != http.StatusOK || s.calls != 1 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID {
		t.Fatalf("catalog: status=%d calls=%d headers=%v", w.Code, s.calls, w.Header())
	}
	w = request(h, "GET", "/api/v1/webhook-event-types?unknown=1", "")
	if w.Code != http.StatusBadRequest || s.calls != 1 {
		t.Fatalf("catalog query: status=%d calls=%d", w.Code, s.calls)
	}
	w = request(h, "POST", "/api/v1/webhook-event-types", "")
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" || w.Header().Get("Daynight-User-ID") != userID || s.calls != 1 {
		t.Fatalf("catalog method: status=%d headers=%v calls=%d", w.Code, w.Header(), s.calls)
	}
}

func TestReadsAndMutationRouting(t *testing.T) {
	s := &fakeService{}
	h := fixture(s, io.Discard)
	base := "/api/v1/me/webhooks/"
	for _, tc := range []struct{ path, kind, id string }{{base + endpointID, "get", endpointID}, {base + "operations/" + operationID, "operation", operationID}, {base + endpointID + "/signing-secret", "secret", endpointID}} {
		w := request(h, "GET", tc.path, "")
		if w.Code != 200 || s.read != tc.kind || s.id != tc.id {
			t.Fatalf("%s: %d %#v", tc.path, w.Code, s)
		}
	}
	body := fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00Z","expectedUserId":"%s","ifVersion":"9007199254740993","mode":"immediate"}`, operationID, userID)
	w := request(h, "POST", base+endpointID+"/signing-secret/rotations", body)
	if w.Code != 200 || s.input.IfVersion != 9007199254740993 || s.input.Kind != "signing.rotate" {
		t.Fatalf("%d %#v", w.Code, s.input)
	}
	w = request(h, "POST", base+endpointID, "{}")
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD, PATCH, DELETE" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Header())
	}
}
func TestListValidation(t *testing.T) {
	s := &fakeService{}
	h := fixture(s, io.Discard)
	base := "/api/v1/me/webhooks"
	w := request(h, "GET", base+"?q=release&enabled=false&limit=10&cursor=abc", "")
	if w.Code != 200 || s.query.Query != "release" || s.query.Enabled == nil || *s.query.Enabled || s.query.Limit != 10 || *s.query.Cursor != "abc" {
		t.Fatal(w.Code, s.query)
	}
	for _, q := range []string{"?cursor=", "?q=a&q=b", "?unknown=x", "?enabled=1", "?limit=101", "?q=%FF"} {
		before := s.calls
		w = request(h, "GET", base+q, "")
		if w.Code != 400 || s.calls != before {
			t.Fatalf("%s: %d", q, w.Code)
		}
	}
}

type shortWriter struct{ header http.Header }

func (w *shortWriter) Header() http.Header       { return w.header }
func (*shortWriter) WriteHeader(int)             {}
func (*shortWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }
func TestCommittedResponseFailureLogsUnknownWithoutSecret(t *testing.T) {
	s := &fakeService{}
	var logs bytes.Buffer
	h := fixture(s, &logs)
	r := httptest.NewRequest("POST", "/api/v1/me/webhooks", strings.NewReader(createBody("https://example.test/private-secret")))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(&shortWriter{header: http.Header{}}, r)
	if s.calls != 1 || !strings.Contains(logs.String(), "write_outcome_unknown") || strings.Contains(logs.String(), "private-secret") {
		t.Fatal(logs.String())
	}
}

func TestMutationValidationAndRouting(t *testing.T) {
	s := &fakeService{}
	h := fixture(s, io.Discard)
	base := "/api/v1/me/webhooks/" + endpointID
	common := fmt.Sprintf(`"operationId":"%s","issuedAt":"2026-11-07T08:00:00Z","expectedUserId":"%s","ifVersion":"2"`, operationID, userID)
	for _, tc := range []struct {
		method, path, body, kind string
		status                   int
	}{
		{"PATCH", base, `{` + common + `,"name":"New"}`, "endpoint.update", 200},
		{"PATCH", base, `{` + common + `,"subscriptions":[ ]}`, "endpoint.update", 200},
		{"DELETE", base, `{` + common + `}`, "endpoint.delete", 200},
		{"PATCH", base, `{` + common + `}`, "", 400},
		{"PATCH", base, `{` + common + `,"confirmProjectIds":[]}`, "endpoint.update", 200},
		{"PATCH", base, `{` + strings.Replace(common, `"2"`, `"02"`, 1) + `,"enabled":false}`, "", 400},
		{"PATCH", base, `{` + strings.Replace(common, `"2"`, `"9223372036854775808"`, 1) + `,"enabled":false}`, "", 400},
		{"POST", base + "/signing-secret/rotations", `{` + common + `,"mode":"other"}`, "", 400},
		{"DELETE", base + "?unknown=1", `{` + common + `}`, "", 400},
		{"GET", "/api/v1/me/webhooks/not-a-uuid", "", "", 400},
		{"GET", base + "/unknown", "", "", 404},
		{"DELETE", base + "/signing-secret", "", "", 405},
	} {
		before := s.calls
		w := request(h, tc.method, tc.path, tc.body)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body)
		}
		if tc.kind != "" {
			if s.calls != before+1 || s.input.Kind != tc.kind {
				t.Fatalf("kind %#v", s.input)
			}
		} else if s.calls != before {
			t.Fatalf("invalid request reached service: %s %s", tc.method, tc.path)
		}
	}
}

func TestUnicodeAndInvalidDestination(t *testing.T) {
	for _, tc := range []struct {
		value string
		ok    bool
	}{
		{`{"x":"\ud83d\ude00"}`, true}, {`{"x":"\ud800"}`, false}, {`{"x":"\udc00"}`, false}, {`{"x":"\ud800\u1234"}`, false}, {`{"x":"\u12"}`, false}, {`{"x":"\\ud800"}`, true},
	} {
		if got := validUnicode([]byte(tc.value)); got != tc.ok {
			t.Errorf("%q: %v", tc.value, got)
		}
	}
	s := &fakeService{}
	h := fixture(s, io.Discard)
	for _, body := range []string{
		strings.Replace(createBody("https://example.test/"), `"kind":"http"`, `"kind":"other"`, 1),
		strings.Replace(createBody("https://example.test/"), `"configuration":{"url":"https://example.test/"}`, `"configuration":null`, 1),
		strings.Replace(createBody("https://example.test/"), `"name":"  Example  "`, `"name":"\u0001"`, 1),
		strings.Replace(createBody("https://example.test/"), `2026-11-07T08:00:00.123400Z`, `2026-11-07T08:00:00+01:00`, 1),
	} {
		before := s.calls
		w := request(h, "POST", "/api/v1/me/webhooks", body)
		if w.Code < 400 || s.calls != before {
			t.Fatalf("accepted %s", body)
		}
	}
}

func TestServiceErrorsDoNotDiscloseSensitiveDiagnostics(t *testing.T) {
	for _, err := range []error{&model.Fault{Code: "forbidden", Message: "https://secret.test/token"}, &model.Fault{Code: "webhook_project_ineligible", Message: "https://secret.test/token"}, fmt.Errorf("database password is private")} {
		var logs bytes.Buffer
		s := &fakeService{err: err}
		h := fixture(s, &logs)
		w := request(h, "GET", "/api/v1/me/webhooks/"+endpointID, "")
		if strings.Contains(w.Body.String(), "secret") || strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), "password") {
			t.Fatal(w.Body.String(), logs.String())
		}
	}
}

func TestFailurePreservesCompletionPriorityAndHidesCauses(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "forbidden"}, 403, "forbidden"},
		{&model.Fault{Code: "webhook_project_ineligible", Message: "private project details"}, 403, "webhook_project_ineligible"},
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "webhook_project_ineligible"}}, 403, "webhook_project_ineligible"},
		{&model.Fault{Code: "webhook_project_ineligible", Cause: &store.Error{DatabaseFailure: true}}, 503, "dependency_unavailable"},
		{&model.Fault{Code: "webhook_project_ineligible", Cause: &store.TransactionError{Phase: "rollback", Outcome: store.TransactionUnknown, CleanupFailed: true}}, 500, "internal_error"},
		{&store.Error{Cause: &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "operation_expired"}}}, 410, "operation_expired"},
		{&model.Fault{Code: "write_outcome_unknown", Cause: &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: &store.Error{DatabaseFailure: true}}}, 503, "write_outcome_unknown"},
		{&model.Fault{Code: "forbidden", Cause: &store.Error{DatabaseFailure: true}}, 503, "dependency_unavailable"},
		{&model.Fault{Code: "forbidden", Cause: &store.TransactionError{Phase: "rollback", Outcome: store.TransactionUnknown, CleanupFailed: true}}, 500, "internal_error"},
	}
	for _, tc := range tests {
		s := &fakeService{err: tc.err}
		h := fixture(s, io.Discard)
		w := request(h, "GET", "/api/v1/me/webhooks/"+endpointID, "")
		if w.Code != tc.status || code(t, w) != tc.code {
			t.Fatalf("%T: %d %s", tc.err, w.Code, w.Body)
		}
	}
}

type unavailableDB struct{ calls int }

func (d *unavailableDB) ReadWebhookSnapshot(context.Context, func(store.WebhookReadScope) error) error {
	d.calls++
	return errTestDB
}
func (d *unavailableDB) WriteWebhook(context.Context, wm.Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error) {
	d.calls++
	return store.Completion{}, errTestDB
}

var errTestDB = errors.New("test database unavailable")

func TestAdapterUsesServiceOperations(t *testing.T) {
	db := &unavailableDB{}
	a := Adapter{Service: &webhookservice.Service{DB: db, ConfigurationExpansionAvailable: true}}
	ctx := context.Background()
	p := model.Principal{UserID: userID}
	owner := Owner{Kind: "personal", ID: userID}
	readers := []func() (any, error){func() (any, error) { return a.List(ctx, p, owner, ListQuery{Limit: 10}) }, func() (any, error) { return a.Get(ctx, p, owner, endpointID) }, func() (any, error) { return a.Operation(ctx, p, owner, operationID) }, func() (any, error) { return a.Secret(ctx, p, owner, endpointID) }}
	for _, read := range readers {
		if _, err := read(); !errors.Is(err, errTestDB) {
			t.Fatalf("read: %v", err)
		}
	}
	m := Mutation{Kind: "endpoint.create", OperationID: operationID, ExpectedUserID: userID, IssuedAt: "2026-11-07T08:00:00Z", Destination: &Destination{Kind: "other", AdapterVersion: "1", URL: "https://example.test/"}}
	if _, err := a.Mutate(ctx, p, owner, m); err == nil || err.(*model.Fault).Code != "destination_unsupported" {
		t.Fatalf("mutation: %v", err)
	}
	m.Destination.Kind = "http"
	if _, err := a.Mutate(ctx, p, owner, m); !errors.Is(err, errTestDB) {
		t.Fatalf("mutation database: %v", err)
	}
	if db.calls != 5 {
		t.Fatalf("database calls %d", db.calls)
	}
}

// The plans contain independent observations. Captured writes never populate a read plan.
type webhookHTTPPlans struct {
	t             *testing.T
	mu            sync.Mutex
	reads, writes []*webhookHTTPScope
	scopes        []*webhookHTTPScope
}

func (p *webhookHTTPPlans) ReadWebhookSnapshot(ctx context.Context, fn func(store.WebhookReadScope) error) error {
	p.mu.Lock()
	if len(p.reads) == 0 {
		p.mu.Unlock()
		p.t.Error("unexpected webhook snapshot")
		panic("unexpected webhook snapshot")
	}
	scope := p.reads[0]
	p.reads = p.reads[1:]
	p.mu.Unlock()
	return fn(scope)
}
func (p *webhookHTTPPlans) WriteWebhook(ctx context.Context, owner wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	p.mu.Lock()
	if len(p.writes) == 0 {
		p.mu.Unlock()
		p.t.Error("unexpected webhook write")
		panic("unexpected webhook write")
	}
	scope := p.writes[0]
	p.writes = p.writes[1:]
	p.mu.Unlock()
	scope.equal(owner, scope.endpoint.Owner, "operation owner")
	scope.equal(id, scope.operation.ID, "operation ID")
	err := fn(scope)
	return store.Completion{Outcome: scope.outcome}, err
}
func (p *webhookHTTPPlans) addRead(scope *webhookHTTPScope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reads = append(p.reads, scope)
	p.scopes = append(p.scopes, scope)
}
func (p *webhookHTTPPlans) addWrite(scope *webhookHTTPScope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writes = append(p.writes, scope)
	p.scopes = append(p.scopes, scope)
}
func (p *webhookHTTPPlans) verify() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.reads) != 0 || len(p.writes) != 0 {
		p.t.Errorf("unconsumed webhook scopes: read=%d write=%d", len(p.reads), len(p.writes))
	}
	for _, scope := range p.scopes {
		scope.mu.Lock()
		if len(scope.want) != 0 {
			p.t.Errorf("unconsumed webhook DAO calls: %v", scope.want)
		}
		scope.mu.Unlock()
	}
}

type webhookHTTPUnusedWriter interface{ store.WebhookWriter }

type webhookHTTPScope struct {
	store.WebhookWriteScope
	webhookHTTPUnusedWriter
	store.WebhookHistoryReader
	store.WebhookEligibilityDAO
	store.CredentialReader
	t                *testing.T
	mu               sync.Mutex
	want             []string
	principal        model.Principal
	now              time.Time
	endpoint         wm.Endpoint
	key              wm.SigningKey
	subscription     wm.Subscription
	binding          wm.Binding
	operation        wm.Operation
	policy           wm.Policy
	delivery         store.WebhookDelivery
	sources          store.WebhookHistorySources
	outcome          store.TransactionOutcome
	operationMissing bool
}

func (s *webhookHTTPScope) call(ctx context.Context, name string) {
	s.t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || len(s.want) == 0 || s.want[0] != name {
		s.t.Errorf("webhook DAO %s, remaining=%v context=%v", name, s.want, ctx.Err())
		panic(fmt.Sprintf("unexpected webhook DAO call %s", name))
	}
	s.want = s.want[1:]
}
func (s *webhookHTTPScope) equal(got, want any, name string) {
	s.t.Helper()
	if !reflect.DeepEqual(got, want) {
		s.t.Errorf("%s: got %#v want %#v", name, got, want)
		panic("webhook DAO argument mismatch")
	}
}
func (s *webhookHTTPScope) CredentialDAO() store.CredentialReader       { return s }
func (s *webhookHTTPScope) WebhookDAO() store.WebhookReader             { return s }
func (s *webhookHTTPScope) WebhookWriter() store.WebhookWriter          { return s }
func (s *webhookHTTPScope) EligibilityDAO() store.WebhookEligibilityDAO { return s }
func (s *webhookHTTPScope) Credential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	s.call(ctx, "Credential")
	s.equal(principal, s.principal, "credential principal")
	return store.ThreadCredential{}, nil
}
func (s *webhookHTTPScope) ObservedAt(ctx context.Context) (time.Time, error) {
	s.call(ctx, "ObservedAt")
	return s.now, nil
}
func (s *webhookHTTPScope) Policy(ctx context.Context, version int64) (wm.Policy, error) {
	s.call(ctx, "Policy")
	s.equal(version, int64(1), "policy version")
	return s.policy, nil
}
func (s *webhookHTTPScope) Endpoint(ctx context.Context, owner wm.Owner, id string) (wm.Endpoint, error) {
	s.call(ctx, "Endpoint")
	s.equal(owner, s.endpoint.Owner, "endpoint owner")
	s.equal(id, s.endpoint.ID, "endpoint ID")
	return s.endpoint, nil
}
func (s *webhookHTTPScope) Endpoints(ctx context.Context, owner wm.Owner) ([]wm.Endpoint, error) {
	s.call(ctx, "Endpoints")
	s.equal(owner, s.endpoint.Owner, "list owner")
	return []wm.Endpoint{}, nil
}
func (s *webhookHTTPScope) SigningKeys(ctx context.Context, endpoint string) ([]wm.SigningKey, error) {
	s.call(ctx, "SigningKeys")
	s.equal(endpoint, s.endpoint.ID, "signing endpoint")
	return []wm.SigningKey{s.key}, nil
}
func (s *webhookHTTPScope) Subscriptions(ctx context.Context, endpoint string) ([]wm.Subscription, error) {
	s.call(ctx, "Subscriptions")
	s.equal(endpoint, s.endpoint.ID, "subscription endpoint")
	return []wm.Subscription{s.subscription}, nil
}
func (s *webhookHTTPScope) Bindings(ctx context.Context, subscription string) ([]wm.Binding, error) {
	s.call(ctx, "Bindings")
	s.equal(subscription, s.subscription.ID, "binding subscription")
	return []wm.Binding{s.binding}, nil
}
func (s *webhookHTTPScope) Operation(ctx context.Context, owner wm.Owner, id string) (wm.Operation, error) {
	s.call(ctx, "Operation")
	s.equal(owner, s.operation.Owner, "receipt owner")
	s.equal(id, s.operation.ID, "receipt ID")
	if s.operationMissing {
		return wm.Operation{}, model.ErrNotFound
	}
	return s.operation, nil
}
func (s *webhookHTTPScope) ReadEligibility(ctx context.Context, owner wm.Owner, project, actor string) (store.WebhookEligibility, error) {
	s.call(ctx, "ReadEligibility")
	s.equal(owner, s.endpoint.Owner, "eligibility owner")
	s.equal(project, s.subscription.ProjectID, "eligibility project")
	s.equal(actor, s.principal.UserID, "eligibility actor")
	name := "maintenance"
	return store.WebhookEligibility{Status: "eligible", ProjectName: &name}, nil
}
func (s *webhookHTTPScope) LockConfigurationSources(ctx context.Context, owner wm.Owner, actor string, projects []string) error {
	s.call(ctx, "LockConfigurationSources")
	s.equal(owner, s.endpoint.Owner, "source owner")
	s.equal(actor, s.principal.UserID, "source actor")
	s.equal(projects, []string{s.subscription.ProjectID}, "configuration projects")
	return nil
}
func (s *webhookHTTPScope) LockCredential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	s.call(ctx, "LockCredential")
	s.equal(principal, s.principal, "locked credential")
	return store.ThreadCredential{}, nil
}
func (s *webhookHTTPScope) PutEndpoint(ctx context.Context, endpoint wm.Endpoint) error {
	s.call(ctx, "PutEndpoint")
	s.equal(endpoint, s.endpoint, "written endpoint")
	return nil
}
func (s *webhookHTTPScope) PutSubscription(ctx context.Context, sub wm.Subscription) error {
	s.call(ctx, "PutSubscription")
	s.equal(sub, s.subscription, "written subscription")
	return nil
}
func (s *webhookHTTPScope) PutBinding(ctx context.Context, binding wm.Binding) error {
	s.call(ctx, "PutBinding")
	s.equal(binding, s.binding, "written binding")
	return nil
}
func (s *webhookHTTPScope) DeleteSigningKeys(ctx context.Context, endpoint string) error {
	s.call(ctx, "DeleteSigningKeys")
	s.equal(endpoint, s.endpoint.ID, "cleared signing endpoint")
	return nil
}
func (s *webhookHTTPScope) PutSigningKey(ctx context.Context, key wm.SigningKey) error {
	s.call(ctx, "PutSigningKey")
	s.equal(key, s.key, "written signing key")
	return nil
}
func (s *webhookHTTPScope) PutOperation(ctx context.Context, operation wm.Operation) error {
	s.call(ctx, "PutOperation")
	s.equal(operation, s.operation, "written operation")
	return nil
}
func (s *webhookHTTPScope) HistoryDisclosure(ctx context.Context, owner wm.Owner, endpoint, actor string, at time.Time) (string, error) {
	s.call(ctx, "HistoryDisclosure")
	s.equal(owner, s.endpoint.Owner, "history owner")
	s.equal(endpoint, s.endpoint.ID, "history endpoint")
	s.equal(actor, s.principal.UserID, "history actor")
	s.equal(at, s.now, "history observation")
	return "current", nil
}
func (s *webhookHTTPScope) HistoryBatch(ctx context.Context, owner wm.Owner, endpoint, actor string, at time.Time, id string, limit int) (store.WebhookHistoryBatch, error) {
	s.call(ctx, "HistoryBatch")
	s.equal(owner, s.endpoint.Owner, "history batch owner")
	s.equal(endpoint, s.endpoint.ID, "history batch endpoint")
	s.equal(actor, s.principal.UserID, "history batch actor")
	s.equal(at, time.Time{}, "history batch position")
	s.equal(id, "", "history batch ID")
	s.equal(limit, 100, "history batch limit")
	name, team, revision := "project", owner.ID, s.endpoint.DestinationRevision
	return store.WebhookHistoryBatch{ObservedAt: s.now, Items: []store.WebhookHistoryItem{{
		Delivery: s.delivery, Sources: s.sources, EventPresent: true,
		Eligibility:     wm.EligibilityFacts{ProjectLive: true, ProjectName: &name, TeamID: &team, TeamPresent: true, OwnerAccess: true, ActorAccess: true},
		EndpointPresent: true, EndpointRevision: &revision,
	}}}, nil
}
func (s *webhookHTTPScope) HistoryMatches(ctx context.Context, ids []string) ([]store.WebhookHistoryMatch, error) {
	s.call(ctx, "HistoryMatches")
	s.equal(ids, []string{s.delivery.ID}, "history match IDs")
	matches := make([]store.WebhookHistoryMatch, 0, len(s.sources.Matches))
	for _, match := range s.sources.Matches {
		matches = append(matches, store.WebhookHistoryMatch{DeliveryID: s.delivery.ID, WebhookAdmissionMatch: match})
	}
	return matches, nil
}
func (s *webhookHTTPScope) HistoryBatchAttempts(ctx context.Context, ids []string) ([]store.WebhookAttempt, error) {
	s.call(ctx, "HistoryBatchAttempts")
	s.equal(ids, []string{s.delivery.ID}, "history attempt IDs")
	return []store.WebhookAttempt{}, nil
}
func (s *webhookHTTPScope) HistoryDeliveries(ctx context.Context, owner wm.Owner, endpoint string, at time.Time, id string, limit int) ([]store.WebhookDelivery, error) {
	s.call(ctx, "HistoryDeliveries")
	s.equal(owner, s.endpoint.Owner, "history collection owner")
	s.equal(endpoint, s.endpoint.ID, "history collection endpoint")
	s.equal(at, time.Time{}, "history position")
	s.equal(id, "", "history ID")
	s.equal(limit, 100, "history limit")
	return []store.WebhookDelivery{s.delivery}, nil
}
func (s *webhookHTTPScope) HistorySources(ctx context.Context, delivery store.WebhookDelivery, actor string) (store.WebhookHistorySources, error) {
	s.call(ctx, "HistorySources")
	s.equal(delivery, s.delivery, "history delivery")
	s.equal(actor, s.principal.UserID, "history source actor")
	return s.sources, nil
}
func (s *webhookHTTPScope) HistoryAttempts(ctx context.Context, delivery string) ([]store.WebhookAttempt, error) {
	s.call(ctx, "HistoryAttempts")
	s.equal(delivery, s.delivery.ID, "history attempts")
	return []store.WebhookAttempt{}, nil
}

func webhookHTTPRandom() *bytes.Reader {
	data := bytes.Repeat([]byte{0x11}, 16)
	data = append(data, bytes.Repeat([]byte{0x22}, 16)...)
	data = append(data, bytes.Repeat([]byte{0x33}, 32)...)
	data = append(data, bytes.Repeat([]byte{0x44}, 16)...)
	data = append(data, bytes.Repeat([]byte{0x55}, 16)...)
	return bytes.NewReader(data)
}
