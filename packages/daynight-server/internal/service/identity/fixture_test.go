package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func TestMain(m *testing.M) {
	for _, name := range []string{"DAYNIGHT_TEST_DATABASE_URL", "DAYNIGHT_TEST_UNIAUTH_FIXTURE", "DAYNIGHT_TEST_UNIAUTH_URL"} {
		if err := os.Unsetenv(name); err != nil {
			panic(err)
		}
	}
	os.Exit(m.Run())
}

type identityCapability struct{ store.IdentityDAO }
type personalCapability struct{ store.PersonalTeamDAO }
type familyCapability struct{ store.CredentialFamilyDAO }
type identityScope struct {
	identity *identityCapability
	personal *personalCapability
	family   *familyCapability
}

func (s *identityScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.family }

func (s *identityScope) IdentityDAO() store.IdentityDAO         { return s.identity }
func (s *identityScope) PersonalTeamDAO() store.PersonalTeamDAO { return s.personal }

type scopeResult struct {
	scope       *identityScope
	callbackErr error
	completion  store.Completion
	err         error
	before      error
}
type identityReply struct {
	status int
	body   any
}
type identityFixture struct {
	t            *testing.T
	identity     *Identity
	ctx          context.Context
	now          time.Time
	plan         []string
	transactions []scopeResult
	calls        atomic.Int32
	replies      map[string]identityReply
	before       func(*http.Request)
	scope        *identityScope
}

func (f *identityFixture) hit(name string) {
	f.t.Helper()
	if len(f.plan) == 0 || f.plan[0] != name {
		f.t.Fatalf("unexpected %s; remaining=%v", name, f.plan)
	}
	f.plan = f.plan[1:]
}
func (f *identityFixture) equal(got, want any) {
	f.t.Helper()
	if !reflect.DeepEqual(got, want) {
		f.t.Fatalf("got %#v; want %#v", got, want)
	}
}
func (f *identityFixture) bound(ctx context.Context, dao store.IdentityDAO) {
	f.t.Helper()
	if ctx != f.ctx || dao != f.scope.identity {
		f.t.Fatal("operation context or transaction capability changed")
	}
}
func (f *identityFixture) WriteIdentity(ctx context.Context, operation func(store.IdentityScope) error) (store.Completion, error) {
	f.hit("write")
	if ctx != f.ctx || len(f.transactions) == 0 {
		f.t.Fatal("unexpected transaction context or extra callback")
	}
	result := f.transactions[0]
	f.transactions = f.transactions[1:]
	f.scope = result.scope
	if result.before != nil {
		return result.completion, result.before
	}
	err := operation(result.scope)
	if err != result.callbackErr {
		f.t.Fatalf("callback error=%v want original %v", err, result.callbackErr)
	}
	f.hit("finish")
	return result.completion, result.err
}
func (f *identityFixture) transaction() {
	f.transactions = append(f.transactions, scopeResult{scope: &identityScope{identity: &identityCapability{}, personal: &personalCapability{}, family: &familyCapability{}}, completion: store.Completion{Outcome: store.TransactionCommitted}})
}
func newIdentityFixture(t *testing.T) *identityFixture {
	t.Helper()
	f := &identityFixture{t: t, ctx: t.Context(), now: time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC), replies: map[string]identityReply{}}
	f.identity = New(f, nil, "https://daynight.example/auth/callback")
	f.identity.ops = identityOperations{}
	f.identity.now = func() time.Time { return f.now.In(time.FixedZone("UTC+08", 8*60*60)) }
	t.Cleanup(func() {
		if len(f.plan) != 0 || len(f.transactions) != 0 {
			t.Errorf("unexecuted operations=%v transactions=%d", f.plan, len(f.transactions))
		}
	})
	return f
}

func newIdentityHTTPFixture(t *testing.T) *identityFixture {
	t.Helper()
	f := newIdentityFixture(t)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		app, password, ok := r.BasicAuth()
		if r.Method != http.MethodPost || r.URL.Path != "/auth/result" || !ok || app != "test-app" || password != "test-secret" {
			t.Error("unexpected SDK result request")
			w.WriteHeader(400)
			return
		}
		var input struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if f.before != nil {
			f.before(r)
		}
		reply, ok := f.replies[input.Code]
		if !ok {
			t.Errorf("unconfigured upstream code %q", input.Code)
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "gateway-request")
		w.WriteHeader(reply.status)
		_ = json.NewEncoder(w).Encode(reply.body)
	}))
	t.Cleanup(gateway.Close)
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.URL, AppID: "test-app", AppSecret: "test-secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	f.identity.client = client

	return f
}
func identityProfile(id string) map[string]any {
	return map[string]any{"provider": "microsoft", "id": id, "email": "shared@example.com", "email_verified": false, "name": "Display name", "avatar_url": nil, "origin": map[string]any{}}
}
func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("want fault %s, got %v", code, err)
	}
	return fault
}
func requireDeviceError(t *testing.T, err error, code string) {
	t.Helper()
	var grant *core.DeviceGrantError
	if !errors.As(err, &grant) || grant.Code != code || grant.Error() == "" {
		t.Fatalf("want device %s, got %v", code, err)
	}
}
func tokenExpiryAt(value time.Time) *time.Time { return &value }
func (f *identityFixture) consume(query url.Values, binding string, pending model.LoginTransaction, failure error) {
	f.identity.ops.validateCallback = func(got url.Values, b string) error {
		f.hit("validate-callback")
		f.equal(got, query)
		f.equal(b, binding)
		return nil
	}
	f.identity.ops.consumeLogin = func(ctx context.Context, dao store.IdentityDAO, state, b string, now time.Time) (model.LoginTransaction, error) {
		f.hit("consume")
		f.bound(ctx, dao)
		f.equal([]any{state, b, now}, []any{query.Get("state"), binding, f.now})
		return pending, failure
	}
}
