package webhook

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type historyBoundaryTransactions struct {
	t     *testing.T
	read  func(context.Context, func(store.WebhookReadScope) error) error
	write func(context.Context, wm.Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error)
}

func historyBoundaryRequire[T any](t *testing.T, method string, fn T, configured bool) T {
	t.Helper()
	if !configured {
		t.Fatalf("unexpected %s", method)
	}
	return fn
}

func (m historyBoundaryTransactions) ReadWebhookSnapshot(c context.Context, f func(store.WebhookReadScope) error) error {
	return historyBoundaryRequire(m.t, "ReadWebhookSnapshot", m.read, m.read != nil)(c, f)
}
func (m historyBoundaryTransactions) WriteWebhook(c context.Context, o wm.Owner, id string, f func(store.WebhookWriteScope) error) (store.Completion, error) {
	return historyBoundaryRequire(m.t, "WriteWebhook", m.write, m.write != nil)(c, o, id, f)
}

type historyBoundaryScope struct {
	t          *testing.T
	credential store.CredentialReader
	team       store.TeamReader
	reader     store.WebhookReader
	writer     store.WebhookWriter
	redelivery store.WebhookRedeliveryScope
	observed   func(context.Context) (time.Time, error)
}

func (m historyBoundaryScope) CredentialDAO() store.CredentialReader {
	return historyBoundaryRequire(m.t, "CredentialDAO", m.credential, m.credential != nil)
}
func (m historyBoundaryScope) TeamDAO() store.TeamReader {
	return historyBoundaryRequire(m.t, "TeamDAO", m.team, m.team != nil)
}
func (m historyBoundaryScope) WebhookDAO() store.WebhookReader {
	return historyBoundaryRequire(m.t, "WebhookDAO", m.reader, m.reader != nil)
}
func (m historyBoundaryScope) WebhookWriter() store.WebhookWriter {
	return historyBoundaryRequire(m.t, "WebhookWriter", m.writer, m.writer != nil)
}
func (m historyBoundaryScope) RedeliveryWriter() store.WebhookRedeliveryScope {
	return historyBoundaryRequire(m.t, "RedeliveryWriter", m.redelivery, m.redelivery != nil)
}
func (m historyBoundaryScope) ObservedAt(c context.Context) (time.Time, error) {
	return historyBoundaryRequire(m.t, "ObservedAt", m.observed, m.observed != nil)(c)
}
func (m historyBoundaryScope) EligibilityDAO() store.WebhookEligibilityDAO {
	m.t.Fatal("unexpected EligibilityDAO")
	return nil
}
func (m historyBoundaryScope) LockConfigurationSources(context.Context, wm.Owner, string, []string) error {
	m.t.Fatal("unexpected LockConfigurationSources")
	return nil
}
func (m historyBoundaryScope) LockAuthority(context.Context, wm.Owner, string) error {
	m.t.Fatal("unexpected LockAuthority")
	return nil
}
func (m historyBoundaryScope) LockCredential(context.Context, model.Principal) (store.ThreadCredential, error) {
	m.t.Fatal("unexpected LockCredential")
	return store.ThreadCredential{}, nil
}

type historyBoundaryCredential struct {
	t    *testing.T
	read func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (m historyBoundaryCredential) Credential(c context.Context, p model.Principal) (store.ThreadCredential, error) {
	return historyBoundaryRequire(m.t, "Credential", m.read, m.read != nil)(c, p)
}

type historyBoundaryTeam struct {
	store.TeamReader
	t    *testing.T
	read func(context.Context, string, string) (model.Team, error)
}

func (m historyBoundaryTeam) Team(c context.Context, actor, id string) (model.Team, error) {
	return historyBoundaryRequire(m.t, "Team", m.read, m.read != nil)(c, actor, id)
}

type historyBoundaryReader struct {
	store.WebhookWriter
	store.WebhookHistoryReader
	t         *testing.T
	endpoint  func(context.Context, wm.Owner, string) (wm.Endpoint, error)
	delivery  func(context.Context, wm.Owner, string, string) (store.WebhookDelivery, error)
	operation func(context.Context, wm.Owner, string) (wm.Operation, error)
	policy    func(context.Context, int64) (wm.Policy, error)
}

func (m *historyBoundaryReader) Endpoint(c context.Context, o wm.Owner, id string) (wm.Endpoint, error) {
	return historyBoundaryRequire(m.t, "Endpoint", m.endpoint, m.endpoint != nil)(c, o, id)
}
func (m *historyBoundaryReader) HistoryDelivery(c context.Context, o wm.Owner, endpoint, id string) (store.WebhookDelivery, error) {
	return historyBoundaryRequire(m.t, "HistoryDelivery", m.delivery, m.delivery != nil)(c, o, endpoint, id)
}
func (m *historyBoundaryReader) Operation(c context.Context, o wm.Owner, id string) (wm.Operation, error) {
	return historyBoundaryRequire(m.t, "Operation", m.operation, m.operation != nil)(c, o, id)
}
func (m *historyBoundaryReader) Policy(c context.Context, v int64) (wm.Policy, error) {
	return historyBoundaryRequire(m.t, "Policy", m.policy, m.policy != nil)(c, v)
}

type historyBoundaryRedelivery struct {
	store.WebhookRedeliveryScope
	t       *testing.T
	sources func(context.Context, string, string, wm.Owner, string, time.Time) (store.WebhookAdmissionSources, error)
}

func (m historyBoundaryRedelivery) AdmissionSourcesForActor(c context.Context, id, endpoint string, o wm.Owner, actor string, at time.Time) (store.WebhookAdmissionSources, error) {
	return historyBoundaryRequire(m.t, "AdmissionSourcesForActor", m.sources, m.sources != nil)(c, id, endpoint, o, actor, at)
}

type historyBoundaryContextKey struct{}

type historyBoundaryAuth struct{}

func historyBoundaryPrincipal() model.Principal {
	return model.Principal{Kind: model.SessionCredential, UserID: userID, CredentialID: "66666666-6666-4666-8666-666666666666"}
}

func (historyBoundaryAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Daynight-User-ID", userID)
		next(w, r, historyBoundaryPrincipal())
	}
}

func historyBoundaryHandler(db store.WebhookTransactions, logs io.Writer) http.Handler {
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	mux := http.NewServeMux()
	(&Routes{service: Adapter{Service: &webhookservice.Service{DB: db, DispatchEnabled: true}}, auth: historyBoundaryAuth{}, logger: logger}).RegisterRoutes(mux)
	return httpx.RequestLogging(logger, mux)
}

func historyBoundaryRequest(h http.Handler, method, path, body string, marker *int) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), historyBoundaryContextKey{}, marker))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Request-ID", "history-adapter-boundary")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func historyBoundaryCheckResponse(t *testing.T, w *httptest.ResponseRecorder, logs string, status int, fault string) {
	t.Helper()
	if w.Code != status || code(t, w) != fault {
		t.Fatalf("response: status=%d body=%s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("X-Request-ID") != "history-adapter-boundary" {
		t.Fatalf("response identity: %v", w.Header())
	}
	for _, value := range []string{userID, endpointID, deliveryID, "history-adapter-boundary", fault} {
		if !strings.Contains(logs, value) {
			t.Fatalf("missing correlation %q: %s", value, logs)
		}
	}
	if strings.Contains(w.Body.String(), "private-storage-cause") || strings.Contains(logs, "private-storage-cause") {
		t.Fatalf("storage cause disclosed: body=%s logs=%s", w.Body, logs)
	}
}

func TestHistoryAdapterAuthorizesOwnerBeforeReadingRetainedResource(t *testing.T) {
	for _, resource := range []string{"", "/payload", "/attempts?generation=4&limit=2"} {
		for _, shared := range []bool{false, true} {
			t.Run(resource+map[bool]string{false: "/personal", true: "/team"}[shared], func(t *testing.T) {
				var logs bytes.Buffer
				marker := 7
				var requestContext context.Context
				var calls []string
				credentialExpiry := time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)
				checkContext := func(c context.Context) {
					t.Helper()
					if c != requestContext || c.Value(historyBoundaryContextKey{}) != &marker {
						t.Fatal("request context was replaced")
					}
				}
				o := wm.Owner{Kind: "personal", ID: userID}
				base := "/api/v1/me/webhooks/"
				if shared {
					o, base = wm.Owner{Kind: "team", ID: teamID}, "/api/v1/teams/"+teamID+"/webhooks/"
				}
				failure := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private-storage-cause")}
				reader := &historyBoundaryReader{t: t}
				reader.endpoint = func(c context.Context, owner wm.Owner, id string) (wm.Endpoint, error) {
					checkContext(c)
					calls = append(calls, "endpoint")
					if owner != o || id != endpointID {
						t.Fatalf("endpoint scope: owner=%v id=%s", owner, id)
					}
					return wm.Endpoint{ID: id, Owner: owner}, nil
				}
				reader.delivery = func(c context.Context, owner wm.Owner, endpoint, id string) (store.WebhookDelivery, error) {
					checkContext(c)
					calls = append(calls, "delivery")
					if owner != o || endpoint != endpointID || id != deliveryID {
						t.Fatalf("retained resource scope: owner=%v endpoint=%s delivery=%s", owner, endpoint, id)
					}
					return store.WebhookDelivery{}, failure
				}
				scope := historyBoundaryScope{t: t, reader: reader, credential: historyBoundaryCredential{t: t, read: func(c context.Context, p model.Principal) (store.ThreadCredential, error) {
					checkContext(c)
					calls = append(calls, "credential")
					if p != historyBoundaryPrincipal() {
						t.Fatalf("credential actor: %+v", p)
					}
					return store.ThreadCredential{ExpiresAt: &credentialExpiry}, nil
				}}}
				if shared {
					scope.team = historyBoundaryTeam{t: t, read: func(c context.Context, actor, id string) (model.Team, error) {
						checkContext(c)
						calls = append(calls, "team")
						if actor != userID || id != teamID {
							t.Fatalf("team authority: actor=%s team=%s", actor, id)
						}
						return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "shared"}, Membership: model.TeamMember{Role: model.ProjectMemberRole}}, nil
					}}
				}
				db := historyBoundaryTransactions{t: t, read: func(c context.Context, f func(store.WebhookReadScope) error) error {
					if requestContext != nil {
						t.Fatal("unexpected extra snapshot")
					}
					requestContext = c
					calls = append(calls, "snapshot")
					err := f(scope)
					if err != failure || !errors.Is(err, failure.Cause) {
						t.Fatalf("callback replaced the storage error: %v", err)
					}
					return err
				}}
				w := historyBoundaryRequest(historyBoundaryHandler(db, &logs), http.MethodGet, base+endpointID+"/deliveries/"+deliveryID+resource, "", &marker)
				historyBoundaryCheckResponse(t, w, logs.String(), http.StatusServiceUnavailable, "dependency_unavailable")
				want := []string{"snapshot", "credential", "endpoint", "delivery"}
				if shared {
					want = []string{"snapshot", "credential", "team", "endpoint", "delivery"}
				}
				if !reflect.DeepEqual(calls, want) {
					t.Fatalf("authorization/read order: got=%v want=%v", calls, want)
				}
			})
		}
	}
}

func TestRedeliveryAdapterRequiresManagementAndPropagatesAdmissionFailure(t *testing.T) {
	for _, role := range []model.ProjectRole{model.ProjectMemberRole, model.ProjectAdmin} {
		t.Run(string(role), func(t *testing.T) {
			var logs bytes.Buffer
			marker := 7
			var requestContext context.Context
			var calls []string
			credentialExpiry := time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)
			checkContext := func(c context.Context) {
				t.Helper()
				if c != requestContext || c.Value(historyBoundaryContextKey{}) != &marker {
					t.Fatal("request context was replaced")
				}
			}
			o := wm.Owner{Kind: "team", ID: teamID}
			now := time.Date(2026, time.November, 7, 8, 0, 1, 0, time.UTC)
			failure := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private-storage-cause")}
			reader := &historyBoundaryReader{t: t}
			reader.operation = func(c context.Context, owner wm.Owner, id string) (wm.Operation, error) {
				checkContext(c)
				calls = append(calls, "operation")
				if owner != o || id != operationID {
					t.Fatalf("operation fence: owner=%v operation=%s", owner, id)
				}
				return wm.Operation{}, model.ErrNotFound
			}
			reader.policy = func(c context.Context, version int64) (wm.Policy, error) {
				checkContext(c)
				calls = append(calls, "policy")
				if version != 1 {
					t.Fatalf("policy version: %d", version)
				}
				return wm.Policy{OperationMaxAgeSeconds: 3600, OperationFutureSkewSeconds: 60}, nil
			}
			scope := historyBoundaryScope{t: t, reader: reader, writer: reader, observed: func(c context.Context) (time.Time, error) {
				checkContext(c)
				calls = append(calls, "observed")
				return now, nil
			}, credential: historyBoundaryCredential{t: t, read: func(c context.Context, p model.Principal) (store.ThreadCredential, error) {
				checkContext(c)
				calls = append(calls, "credential")
				if p != historyBoundaryPrincipal() {
					t.Fatalf("credential actor: %+v", p)
				}
				return store.ThreadCredential{ExpiresAt: &credentialExpiry}, nil
			}}, team: historyBoundaryTeam{t: t, read: func(c context.Context, actor, id string) (model.Team, error) {
				checkContext(c)
				calls = append(calls, "team")
				if actor != userID || id != teamID {
					t.Fatalf("team authority: actor=%s team=%s", actor, id)
				}
				return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "shared"}, Membership: model.TeamMember{Role: role}}, nil
			}}, redelivery: historyBoundaryRedelivery{t: t, sources: func(c context.Context, id, endpoint string, owner wm.Owner, actor string, at time.Time) (store.WebhookAdmissionSources, error) {
				checkContext(c)
				calls = append(calls, "sources")
				if id != deliveryID || endpoint != endpointID || owner != o || actor != userID || !at.Equal(now) {
					t.Fatalf("admission scope: delivery=%s endpoint=%s owner=%v actor=%s at=%s", id, endpoint, owner, actor, at)
				}
				return store.WebhookAdmissionSources{}, failure
			}}}
			db := historyBoundaryTransactions{t: t, read: func(c context.Context, f func(store.WebhookReadScope) error) error {
				if requestContext != nil {
					t.Fatal("unexpected extra snapshot")
				}
				requestContext = c
				calls = append(calls, "snapshot")
				return f(scope)
			}, write: func(c context.Context, owner wm.Owner, id string, f func(store.WebhookWriteScope) error) (store.Completion, error) {
				checkContext(c)
				calls = append(calls, "write")
				if owner != o || id != operationID {
					t.Fatalf("write fence: owner=%v operation=%s", owner, id)
				}
				err := f(scope)
				if role == model.ProjectAdmin {
					if err != failure || !errors.Is(err, failure.Cause) {
						t.Fatalf("callback replaced the admission error: %v", err)
					}
				} else {
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != "forbidden" {
						t.Fatalf("member reached an admission: %v", err)
					}
				}
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}}
			w := historyBoundaryRequest(historyBoundaryHandler(db, &logs), http.MethodPost, "/api/v1/teams/"+teamID+"/webhooks/"+endpointID+"/deliveries/"+deliveryID+"/redeliveries", redeliveryWireBody(), &marker)
			status, fault := http.StatusForbidden, "forbidden"
			want := []string{"snapshot", "credential", "team", "write", "operation", "credential", "team"}
			if role == model.ProjectAdmin {
				status, fault = http.StatusServiceUnavailable, "dependency_unavailable"
				want = append(want, "policy", "observed", "sources")
			}
			historyBoundaryCheckResponse(t, w, logs.String(), status, fault)
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("operation/admission order: got=%v want=%v", calls, want)
			}
		})
	}
}

func TestAttemptRoutesRejectMalformedPaginationBeforeOpeningSnapshot(t *testing.T) {
	for _, suffix := range []string{"?", "?limit=", "?limit=101", "?cursor=", "?generation=", "?generation=0", "?generation=4&generation=5", "?generation=%zz"} {
		t.Run(suffix, func(t *testing.T) {
			db := historyBoundaryTransactions{t: t}
			marker := 7
			w := historyBoundaryRequest(historyBoundaryHandler(db, io.Discard), http.MethodGet, "/api/v1/me/webhooks/"+endpointID+"/deliveries/"+deliveryID+"/attempts"+suffix, "", &marker)
			if w.Code != http.StatusBadRequest || code(t, w) != "invalid_input" {
				t.Fatalf("invalid query response: status=%d body=%s", w.Code, w.Body)
			}
		})
	}
}

func TestAttemptRoutesPreserveGenerationAndPaginationInputs(t *testing.T) {
	s := &historyFake{}
	w := request(historyFixture(s), http.MethodGet, "/api/v1/me/webhooks/"+endpointID+"/deliveries/"+deliveryID+"/attempts?generation=9223372036854775807&limit=2&cursor=retained-position", "")
	if w.Code != http.StatusOK || s.calls != 1 || s.attemptQuery.Generation == nil || *s.attemptQuery.Generation != 9223372036854775807 || s.attemptQuery.Limit != 2 || s.attemptQuery.Cursor == nil || *s.attemptQuery.Cursor != "retained-position" {
		t.Fatalf("attempt pagination input: status=%d query=%+v calls=%d", w.Code, s.attemptQuery, s.calls)
	}
}
