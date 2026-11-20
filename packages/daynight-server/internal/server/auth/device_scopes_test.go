package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

type scopedDeviceStub struct {
	inspect func(context.Context, model.Principal, string) (identitycore.DeviceInspectionV2, error)
	decide  func(context.Context, model.Principal, string, string, string, string, []scopepolicy.ScopeID) error
}

type scopedIdentityStub struct {
	*strictIdentity
	scopedDeviceStub
	catalog  scopepolicy.CatalogSnapshot
	disabled bool
}

func (s scopedIdentityStub) DeviceScopeCatalog() (scopepolicy.CatalogSnapshot, bool) {
	return s.catalog.Clone(), !s.disabled
}

func TestScopedDeviceRoutesRejectLegacyIdentity(t *testing.T) {
	legacy := &strictIdentity{t: t, callback: func() string { return authRequestOrigin + "/auth/callback" }}
	mcp, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	for _, identity := range []identityOperations{legacy, scopedIdentityStub{strictIdentity: legacy, disabled: true}} {
		auth, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatal(err)
		}
		mux := http.NewServeMux()
		if err := auth.RegisterScopedDeviceRoutes(mux, mcp); err == nil {
			t.Fatal("legacy issuer admitted scoped routes")
		}
		_, pattern := mux.Handler(httptest.NewRequest("POST", "/api/v2/auth/device/decision", nil))
		if pattern != "" {
			t.Fatal("refused registration exposed a route")
		}
	}
}

func (s scopedDeviceStub) InspectDeviceV2(ctx context.Context, p model.Principal, code string) (identitycore.DeviceInspectionV2, error) {
	return s.inspect(ctx, p, code)
}
func (s scopedDeviceStub) DecideDeviceV2(ctx context.Context, p model.Principal, code, decision, user, revision string, scopes []scopepolicy.ScopeID) error {
	return s.decide(ctx, p, code, decision, user, revision, scopes)
}

func TestScopedDeviceRoutes(t *testing.T) {
	principal, _ := authRequestAccount(1)
	pat, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read", "team:read"})
	if err != nil {
		t.Fatal(err)
	}
	mcp, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	identity := &strictIdentity{t: t, callback: func() string { return authRequestOrigin + "/auth/callback" }}
	identity.authenticate = func(_ context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		if kind != model.SessionCredential || value != authAliceCookie {
			t.Fatal("unexpected authentication")
		}
		return principal, nil
	}
	operations := 0
	var decisionError error
	stub := scopedDeviceStub{
		inspect: func(ctx context.Context, p model.Principal, code string) (identitycore.DeviceInspectionV2, error) {
			operations++
			if _, ok := ctx.Deadline(); !ok || p != principal || code != "BCDFG-HJKLM" {
				t.Fatal("inspect arguments")
			}
			return identitycore.DeviceInspectionV2{DeviceInspection: identitycore.DeviceInspection{UserCode: code, Status: "pending", ExpiresAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}, CatalogRevision: &pat.CatalogRevision}, nil
		},
		decide: func(ctx context.Context, p model.Principal, code, decision, user, revision string, scopes []scopepolicy.ScopeID) error {
			operations++
			if _, ok := ctx.Deadline(); !ok || p != principal || code != "BCDFG-HJKLM" || user != p.UserID {
				t.Fatal("decision arguments")
			}
			if decision == "approve" && (revision != pat.CatalogRevision || !reflect.DeepEqual(scopes, []scopepolicy.ScopeID{"task:read"})) {
				t.Fatal("approval selection lost")
			}
			if decision == "deny" && (revision != "" || scopes != nil) {
				t.Fatal("denial included selection")
			}
			return decisionError
		},
	}
	auth, err := NewAuthentication(scopedIdentityStub{strictIdentity: identity, scopedDeviceStub: stub, catalog: pat.Clone()}, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	if err := auth.RegisterScopedDeviceRoutes(mux, mcp); err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string, cookie, origin, bearer bool) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if cookie {
			r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: authAliceCookie})
		}
		if origin {
			r.Header.Set("Origin", authRequestOrigin)
		}
		if bearer {
			r.Header.Set("Authorization", "Bearer secret")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	const catalogPath = "/api/v1/me/credential-scope-catalog"
	const inspectPath = "/api/v2/auth/device/inspect"
	const decisionPath = "/api/v2/auth/device/decision"
	catalog := request("GET", catalogPath, "", true, false, false)
	var got struct {
		PAT scopepolicy.CatalogSnapshot `json:"pat"`
		MCP scopepolicy.CatalogSnapshot `json:"mcp"`
	}
	if catalog.Code != 200 || json.Unmarshal(catalog.Body.Bytes(), &got) != nil || got.PAT.CatalogRevision != pat.CatalogRevision || got.MCP.CatalogRevision != mcp.CatalogRevision || !reflect.DeepEqual(got.PAT.Groups, pat.Groups) || catalog.Header().Get("Daynight-User-ID") != principal.UserID || catalog.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("catalog: %d %s", catalog.Code, catalog.Body)
	}
	pat.Groups[0].ScopeIDs[0] = "task:write"
	pat.DefaultScopes[0] = "task:write"
	var afterMutation struct {
		PAT scopepolicy.CatalogSnapshot `json:"pat"`
	}
	readAgain := request("GET", catalogPath, "", true, false, false)
	if readAgain.Code != 200 || json.Unmarshal(readAgain.Body.Bytes(), &afterMutation) != nil || !reflect.DeepEqual(afterMutation.PAT.Groups, got.PAT.Groups) || !reflect.DeepEqual(afterMutation.PAT.DefaultScopes, got.PAT.DefaultScopes) {
		t.Fatalf("catalog changed after caller mutation: %d %s", readAgain.Code, readAgain.Body)
	}
	inspect := request("POST", inspectPath, `{"userCode":"BCDFG-HJKLM"}`, true, true, false)
	var inspection identitycore.DeviceInspectionV2
	if inspect.Code != 200 || json.Unmarshal(inspect.Body.Bytes(), &inspection) != nil || inspection.CatalogRevision == nil || *inspection.CatalogRevision != pat.CatalogRevision || inspection.Status != "pending" || inspect.Header().Get("Daynight-User-ID") != principal.UserID || inspect.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("inspect: %d %s", inspect.Code, inspect.Body)
	}
	base := `"userCode":"BCDFG-HJKLM","expectedUserId":"` + principal.UserID + `"`
	approve := `{` + base + `,"decision":"approve","catalogRevision":"` + pat.CatalogRevision + `","scopes":["task:read"]}`
	deny := `{` + base + `,"decision":"deny"}`
	for _, body := range []string{approve, deny} {
		if w := request("POST", decisionPath, body, true, true, false); w.Code != 204 {
			t.Fatalf("decision: %d %s", w.Code, w.Body)
		}
	}
	before := operations
	for _, tc := range []struct {
		method, path, body     string
		cookie, origin, bearer bool
		status                 int
	}{
		{"GET", catalogPath + "?extra=1", "", true, false, false, 400},
		{"HEAD", catalogPath, "", true, false, false, 405},
		{"GET", inspectPath, "", true, false, false, 405},
		{"POST", inspectPath, `{"userCode":"BCDFG-HJKLM"}`, true, false, false, 403},
		{"POST", inspectPath, `{"userCode":"BCDFG-HJKLM"}`, true, true, true, 403},
		{"POST", inspectPath, `{"userCode":"BCDFG-HJKLM"}`, false, true, false, 401},
		{"POST", inspectPath + "?extra=1", `{"userCode":"BCDFG-HJKLM"}`, true, true, false, 400},
		{"POST", decisionPath, `{` + base + `,"decision":"approve"}`, true, true, false, 400},
		{"POST", decisionPath, `{` + base + `,"decision":"approve","catalogRevision":"x","scopes":[]}`, true, true, false, 400},
		{"POST", decisionPath, `{` + base + `,"decision":"approve","catalogRevision":"x","scopes":[null]}`, true, true, false, 400},
		{"POST", decisionPath, `{` + base + `,"decision":"deny","scopes":[]}`, true, true, false, 400},
		{"POST", decisionPath, `{` + base + `,"decision":"deny","catalogRevision":"x"}`, true, true, false, 400},
		{"POST", decisionPath, strings.Replace(approve, principal.UserID, "10000000-0000-4000-8000-000000000002", 1), true, true, false, 403},
		{"POST", decisionPath, strings.Replace(approve, `"task:read"`, `"\ud800"`, 1), true, true, false, 400},
		{"POST", decisionPath, strings.Replace(approve, `"decision":"approve"`, `"decision":"approve","decision":"approve"`, 1), true, true, false, 400},
	} {
		w := request(tc.method, tc.path, tc.body, tc.cookie, tc.origin, tc.bearer)
		if w.Code != tc.status || operations != before {
			t.Fatalf("%s %s %s: %d %s", tc.method, tc.path, tc.body, w.Code, w.Body)
		}
	}
	decisionError = &model.Fault{Code: "version_conflict", Message: "Catalog changed."}
	if w := request("POST", decisionPath, approve, true, true, false); w.Code != 409 {
		t.Fatalf("conflict: %d %s", w.Code, w.Body)
	}
	decisionError = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("private short code")}
	if w := request("POST", decisionPath, approve, true, true, false); w.Code != 503 || !strings.Contains(w.Body.String(), "write_outcome_unknown") || strings.Contains(w.Body.String(), "private short code") {
		t.Fatalf("unknown: %d %s", w.Code, w.Body)
	}
}
