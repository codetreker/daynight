package grants

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type scopedStub struct {
	items   []store.OAuthGrant
	now     time.Time
	calls   int
	err     error
	version int64
	scopes  []scopepolicy.ScopeID
}

func (s *scopedStub) ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error) {
	return s.items, s.now, s.err
}
func (s *scopedStub) UpdateSessionGrantScope(_ context.Context, _ model.Principal, _, _ string, version int64, _ string, scopes []scopepolicy.ScopeID) (store.OAuthGrant, time.Time, error) {
	s.calls++
	s.version = version
	s.scopes = scopes
	return s.items[0], s.now, s.err
}

func TestScopedGrantProjectionAndMutation(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 9007199254740993)
	if err != nil {
		t.Fatal(err)
	}
	item := store.OAuthGrant{ID: uuid.NewString(), UserID: p.UserID, ClientID: "client", ClientSnapshot: []byte(`{"clientId":"client","clientName":"Example"}`), Resource: "https://example.test/mcp", Scope: core.Scope, CreatedAt: now, ExpiresAt: now.Add(time.Hour), ScopePolicy: &policy}
	fixed := item
	fixed.ID = uuid.NewString()
	fixed.ScopePolicy = nil
	fixed.ExpiresAt = now.Add(-time.Hour)
	s := &scopedStub{items: []store.OAuthGrant{item, fixed}, now: now}
	h := routes{grants: observedLifecycle{}, scoped: s, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	w := httptest.NewRecorder()
	h.listV3(w, httptest.NewRequest("GET", "/api/v3/oauth/grants", nil), p)
	var page struct {
		UserID string                       `json:"userId"`
		Grants []map[string]json.RawMessage `json:"grants"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Grants) != 2 || page.UserID != p.UserID {
		t.Fatalf("page: %d %s", w.Code, w.Body)
	}
	if string(page.Grants[0]["scopePolicy"]) != `{"scopes":["task:read"],"scopeVersion":"9007199254740993"}` || string(page.Grants[1]["scopePolicy"]) != "null" || string(page.Grants[1]["status"]) != `"expired"` || len(page.Grants[0]) != 12 {
		t.Fatalf("views: %s", w.Body)
	}
	body := `{"expectedUserId":"` + p.UserID + `","expectedScopeVersion":"9007199254740993","catalogRevision":"abc","scopes":["task:read"]}`
	request := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("PATCH", "/api/v3/oauth/grants/"+item.ID+"/scopes", strings.NewReader(body))
		r.SetPathValue("id", item.ID)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.updateScopes(w, r, p)
		return w
	}
	w = request(body)
	if w.Code != 200 || s.calls != 1 || s.version != 9007199254740993 || !reflect.DeepEqual(s.scopes, []scopepolicy.ScopeID{"task:read"}) || !strings.Contains(w.Body.String(), `"scopeVersion":"9007199254740993"`) {
		t.Fatalf("mutation: %d %s", w.Code, w.Body)
	}
	for _, bad := range []string{strings.Replace(body, `"9007199254740993"`, `9007199254740993`, 1), strings.Replace(body, `"9007199254740993"`, `"01"`, 1), strings.Replace(body, `["task:read"]`, `[]`, 1), strings.Replace(body, `"scopes"`, `"other"`, 1)} {
		w = request(bad)
		if w.Code != 400 || s.calls != 1 {
			t.Fatalf("invalid input: %d %s", w.Code, w.Body)
		}
	}
	s.err = core.ErrAuthorizationUnknown
	w = request(body)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "write_outcome_unknown") || s.calls != 2 {
		t.Fatalf("unknown: %d %s", w.Code, w.Body)
	}
	s.err = errors.New("unavailable")
	w = request(body)
	if w.Code != 500 || s.calls != 3 {
		t.Fatalf("failure: %d %s", w.Code, w.Body)
	}
}
