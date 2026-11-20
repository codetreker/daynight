package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

func TestCredentialTokenHTTP(t *testing.T) {
	principal, _ := authRequestAccount(1)
	tokenID := "40000000-0000-4000-8000-000000000001"
	secret := "dnpat_do_not_log_this_secret"
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	authenticationCalls, operations := 0, 0
	var authDeadline, operationDeadline time.Time
	identity := &strictIdentity{t: t, callback: func() string { return authRequestOrigin + "/auth/callback" }}
	identity.authenticate = func(ctx context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		authenticationCalls++
		authDeadline, _ = ctx.Deadline()
		if kind != model.SessionCredential || value != authAliceCookie {
			t.Fatalf("unexpected authentication: %v", kind)
		}
		return principal, nil
	}
	token := model.PersonalAccessToken{ID: tokenID, UserID: principal.UserID, Name: "sample", CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	value := "private description"
	identity.listPATsV2 = func(ctx context.Context, p model.Principal) ([]model.PersonalAccessToken, error) {
		operations++
		operationDeadline, _ = ctx.Deadline()
		if p != principal {
			t.Fatal("wrong principal")
		}
		token.Description = &value
		return []model.PersonalAccessToken{token}, nil
	}
	identity.createPATV2 = func(ctx context.Context, p model.Principal, user string, input identitycore.CreatePAT, description *string) (identitycore.MintedPAT, error) {
		operations++
		operationDeadline, _ = ctx.Deadline()
		if p != principal || user != p.UserID || input.Name != "sample" || input.ExpiresAt != nil || description == nil || *description != " private description " {
			t.Fatal("invalid create propagation")
		}
		token.Description = &value
		return identitycore.MintedPAT{Credential: token, Secret: secret}, nil
	}
	identity.updateDescription = func(ctx context.Context, p model.Principal, id, user string, expected, description *string) (string, *string, error) {
		operations++
		operationDeadline, _ = ctx.Deadline()
		if p != principal || id != tokenID || user != p.UserID || expected != nil || description == nil || *description != " private description " {
			t.Fatal("invalid patch propagation")
		}
		return id, &value, nil
	}
	auth, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	request := func(method, path, body string, cookie, origin bool, authorization []string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if cookie {
			r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: authAliceCookie})
		}
		if origin {
			r.Header.Set("Origin", authRequestOrigin)
		}
		if authorization != nil {
			r.Header["Authorization"] = authorization
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	list := request("GET", "/api/v2/me/tokens", "", true, false, nil)
	var listed struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if list.Code != 200 || json.Unmarshal(list.Body.Bytes(), &listed) != nil || len(listed.Items) != 1 || len(listed.Items[0]) != 6 || string(listed.Items[0]["description"]) != `"private description"` {
		t.Fatalf("list: %d %s", list.Code, list.Body)
	}
	if list.Header().Get("Daynight-User-ID") != principal.UserID || list.Header().Get("Cache-Control") != "no-store" || authDeadline.IsZero() || operationDeadline.IsZero() {
		t.Fatal("missing authentication, deadline, or response headers")
	}
	body := `{"expectedUserId":"` + principal.UserID + `","name":"sample","expiresAt":null,"description":" private description "}`
	created := request("POST", "/api/v2/me/tokens", body, true, true, nil)
	var fields map[string]json.RawMessage
	if created.Code != 201 || json.Unmarshal(created.Body.Bytes(), &fields) != nil || len(fields) != 7 || string(fields["token"]) != `"`+secret+`"` || created.Header().Get("Location") != "/api/v1/me/tokens/"+tokenID {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	patch := request("PATCH", "/api/v2/me/tokens/"+tokenID+"/description", `{"expectedUserId":"`+principal.UserID+`","expectedDescription":null,"description":" private description "}`, true, true, nil)
	if patch.Code != 200 || strings.TrimSpace(patch.Body.String()) != `{"id":"`+tokenID+`","description":"private description"}` {
		t.Fatalf("patch: %d %s", patch.Code, patch.Body)
	}
	beforeAuth, beforeOps := authenticationCalls, operations
	denied := request("POST", "/api/v2/me/tokens", body, true, true, []string{"Bearer x"})
	if denied.Code != 403 || denied.Header().Get("Daynight-User-ID") != "" || authenticationCalls != beforeAuth || operations != beforeOps {
		t.Fatalf("bearer: %d %s", denied.Code, denied.Body)
	}
	denied = request("POST", "/api/v2/me/tokens", body, true, false, nil)
	if denied.Code != 403 || denied.Header().Get("Daynight-User-ID") != principal.UserID || operations != beforeOps {
		t.Fatalf("origin: %d %s", denied.Code, denied.Body)
	}
	denied = request("GET", "/api/v2/me/tokens", "", false, false, nil)
	if denied.Code != 401 || denied.Header().Get("Daynight-User-ID") != "" {
		t.Fatalf("missing session: %d", denied.Code)
	}
	denied = request("HEAD", "/api/v2/me/tokens", "", true, false, nil)
	if denied.Code != 405 || denied.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("head: %d %v", denied.Code, denied.Header())
	}
	for _, invalid := range []string{
		`{}`, `{"expectedUserId":"` + principal.UserID + `","expectedDescription":null}`,
		`{"expectedUserId":"` + principal.UserID + `","expectedDescription":null,"description":"\ud800"}`,
		`{"expectedUserId":"` + principal.UserID + `","expectedDescription":null,"description":false}`,
		`{"expectedUserId":"` + principal.UserID + `","expectedDescription":null,"description":null,"description":null}`,
		`{"expectedUserId":"` + principal.UserID + `","expectedDescription":null,"description":null,"extra":1}`,
	} {
		denied = request("PATCH", "/api/v2/me/tokens/"+tokenID+"/description", invalid, true, true, nil)
		if denied.Code != 400 || operations != beforeOps {
			t.Fatalf("invalid body %q: %d %s", invalid, denied.Code, denied.Body)
		}
	}
	denied = request("POST", "/api/v2/me/tokens", strings.Replace(body, principal.UserID, "10000000-0000-4000-8000-000000000002", 1), true, true, nil)
	if denied.Code != 403 || operations != beforeOps {
		t.Fatalf("wrong user: %d %s", denied.Code, denied.Body)
	}
	denied = request("GET", "/api/v2/me/tokens?extra=1", "", true, false, nil)
	if denied.Code != 400 || operations != beforeOps {
		t.Fatalf("query: %d", denied.Code)
	}
	identity.createPATV2 = func(context.Context, model.Principal, string, identitycore.CreatePAT, *string) (identitycore.MintedPAT, error) {
		return identitycore.MintedPAT{Credential: token, Secret: secret}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private description " + secret)}
	}
	unknown := request("POST", "/api/v2/me/tokens", body, true, true, nil)
	if unknown.Code != 503 || !strings.Contains(unknown.Body.String(), "write_outcome_unknown") || strings.Contains(unknown.Body.String(), secret) {
		t.Fatalf("unknown: %d %s", unknown.Code, unknown.Body)
	}
	identity.authenticate = func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		return model.Principal{}, &store.Error{Phase: "begin identity", Cause: context.DeadlineExceeded}
	}
	timeout := request("GET", "/api/v2/me/tokens", "", true, false, nil)
	if timeout.Code != 504 || !strings.Contains(timeout.Body.String(), `"timeout"`) || timeout.Header().Get("Daynight-User-ID") != "" {
		t.Fatalf("authentication timeout: %d %s", timeout.Code, timeout.Body)
	}
	identity.authenticate = func(context.Context, model.CredentialKind, string) (model.Principal, error) { return principal, nil }
	identity.updateDescription = func(context.Context, model.Principal, string, string, *string, *string) (string, *string, error) {
		return "", nil, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{Phase: "update", DatabaseFailure: true, Cause: &net.OpError{Op: "read", Net: "tcp", Err: context.DeadlineExceeded}}}
	}
	patchBody := `{"expectedUserId":"` + principal.UserID + `","expectedDescription":null,"description":" private description "}`
	timeout = request("PATCH", "/api/v2/me/tokens/"+tokenID+"/description", patchBody, true, true, nil)
	if timeout.Code != 504 || !strings.Contains(timeout.Body.String(), `"timeout"`) {
		t.Fatalf("operation timeout: %d %s", timeout.Code, timeout.Body)
	}
	invalidID := request("PATCH", "/api/v2/me/tokens/private-description-secret/description", patchBody, true, true, nil)
	if invalidID.Code != 400 || strings.Contains(logs.String(), "private-description-secret") {
		t.Fatalf("unsafe target ID: %d %s", invalidID.Code, logs.String())
	}
	if !strings.Contains(logs.String(), `"error_code":"timeout"`) {
		t.Fatalf("timeout classification missing: %s", logs.String())
	}
	// A session can expire after admission while the transaction waits for a row.
	// The classified authentication refusal wraps a missing Session row.
	sessionExpired := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.Unauthenticated(model.ErrNotFound)}
	createCalls, patchCalls := 0, 0
	identity.createPATV2 = func(context.Context, model.Principal, string, identitycore.CreatePAT, *string) (identitycore.MintedPAT, error) {
		createCalls++
		return identitycore.MintedPAT{Credential: token, Secret: secret}, sessionExpired
	}
	identity.updateDescription = func(context.Context, model.Principal, string, string, *string, *string) (string, *string, error) {
		patchCalls++
		return tokenID, &value, sessionExpired
	}
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/v2/me/tokens", body},
		{"PATCH", "/api/v2/me/tokens/" + tokenID + "/description", patchBody},
	} {
		denied := request(tc.method, tc.path, tc.body, true, true, nil)
		if denied.Code != 401 || !strings.Contains(denied.Body.String(), `"unauthenticated"`) || denied.Header().Get("Daynight-User-ID") != principal.UserID || denied.Header().Get("Location") != "" || strings.Contains(denied.Body.String(), secret) || strings.Contains(denied.Body.String(), value) {
			t.Fatalf("%s expired session: %d %v %s", tc.method, denied.Code, denied.Header(), denied.Body)
		}
	}
	if createCalls != 1 || patchCalls != 1 {
		t.Fatalf("expired session operation calls: create=%d patch=%d", createCalls, patchCalls)
	}
	identity.updateDescription = func(context.Context, model.Principal, string, string, *string, *string) (string, *string, error) {
		return "", nil, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
	}
	missing := request("PATCH", "/api/v2/me/tokens/"+tokenID+"/description", patchBody, true, true, nil)
	if missing.Code != 404 || !strings.Contains(missing.Body.String(), `"not_found"`) {
		t.Fatalf("missing target: %d %s", missing.Code, missing.Body)
	}
	if !strings.Contains(logs.String(), `"cleanup_failed":true`) || !strings.Contains(logs.String(), `"transaction_phase":"commit"`) || !strings.Contains(logs.String(), `"error_code":"write_outcome_unknown"`) {
		t.Fatalf("missing completion facts: %s", logs.String())
	}
	if strings.Contains(logs.String(), secret) || strings.Contains(logs.String(), value) {
		t.Fatalf("sensitive data logged: %s", logs.String())
	}
}
