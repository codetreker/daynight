package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

func TestOAuthPublicProfileProductionRoutes(t *testing.T) {
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	session := h.Login(t, "public-profile-user")
	config := configuredTestConfig()
	config.PublicOrigin, config.AllowHTTPTestOrigin = h.Origin, true
	config.UniAuthCallbackURL = h.Origin + "/api/v1/auth/callback"
	config.OAuthClients = map[string][]byte{"known": []byte(`{"client_id":"known","client_name":"Known","redirect_uris":["https://client.example/callback"]}`)}
	handler, err := newTestHandler(Dependencies{Store: h.Database, Ready: h.Database.Ready, Files: attachmentTestFiles(t)}, config, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer handler.(Handler).Shutdown(context.Background())
	send := func(method, path, body, contentType string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		if method == http.MethodPost {
			req.Header.Set("Origin", h.Origin)
		}
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	w := send("GET", "/mcp", "", "")
	if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") != `Bearer resource_metadata="`+h.Origin+`/.well-known/oauth-protected-resource/mcp"` {
		t.Fatalf("challenge: %d %q", w.Code, w.Header().Get("WWW-Authenticate"))
	}
	w = send("GET", "/.well-known/oauth-authorization-server", "", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"registration_endpoint":"`+h.Origin+`/oauth/register"`) {
		t.Fatalf("metadata: %d %s", w.Code, w.Body.String())
	}
	const callback = "http://127.0.0.1:9012/callback"
	w = send("POST", "/oauth/register", `{"client_name":"Public client","redirect_uris":["http://127.0.0.1/callback"]}`, "application/json")
	if w.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", w.Code, w.Body.String())
	}
	var registration struct {
		ClientID string `json:"client_id"`
		Method   string `json:"token_endpoint_auth_method"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &registration); err != nil || registration.ClientID == "" || registration.Method != "none" {
		t.Fatalf("registration: %#v %v", registration, err)
	}
	verifier := strings.Repeat("v", 43)
	hash := sha256.Sum256([]byte(verifier))
	q := url.Values{"client_id": {registration.ClientID}, "redirect_uri": {callback}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {h.Origin + "/mcp"}, "state": {"state"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash[:])}, "code_challenge_method": {"S256"}}
	known := url.Values{}
	for key, value := range q {
		known[key] = value
	}
	known.Set("client_id", "known")
	known.Set("redirect_uri", "https://client.example/callback")
	if got := send("GET", "/oauth/authorize?"+known.Encode(), "", ""); got.Code != http.StatusSeeOther {
		t.Fatalf("preregistered client: %d", got.Code)
	}
	w = send("GET", "/oauth/authorize?"+q.Encode(), "", "")
	if w.Code != http.StatusSeeOther || len(w.Result().Cookies()) != 1 {
		t.Fatalf("start: %d %s", w.Code, w.Body.String())
	}
	location, err := url.Parse(w.Header().Get("Location"))
	if err != nil || location.Path != "/oauth/consent" {
		t.Fatalf("location: %s %v", w.Header().Get("Location"), err)
	}
	id, binding := location.Query().Get("request"), w.Result().Cookies()[0]
	w = send("GET", location.String(), "", "", session, binding)
	if w.Code != http.StatusOK || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("consent: %d %s", w.Code, w.Body.String())
	}
	w = send("GET", "/api/v1/oauth/requests/"+id, "", "", session, binding)
	var view struct{ UserID, Status, ClientProvenance string }
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil || w.Code != 200 || view.UserID == "" || view.Status != "pending" || view.ClientProvenance != "dcr" {
		t.Fatalf("inspect: %d %s %v", w.Code, w.Body.String(), err)
	}
	wrongAccount, _ := json.Marshal(map[string]string{"expectedUserId": "00000000-0000-4000-8000-000000000001", "decision": "approve"})
	w = send("POST", "/api/v1/oauth/requests/"+id+"/decision", string(wrongAccount), "application/json", session, binding)
	if w.Code == http.StatusOK {
		t.Fatal("decision accepted a changed account")
	}
	body, _ := json.Marshal(map[string]string{"expectedUserId": view.UserID, "decision": "approve"})
	w = send("POST", "/api/v1/oauth/requests/"+id+"/decision", string(body), "application/json", session, binding)
	var decision struct {
		RedirectURI string `json:"redirectUri"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &decision); err != nil || w.Code != 200 {
		t.Fatalf("decision: %d %s %v", w.Code, w.Body.String(), err)
	}
	redirect, err := url.Parse(decision.RedirectURI)
	if err != nil || redirect.Host != "127.0.0.1:9012" || redirect.Query().Get("state") != "state" || redirect.Query().Get("iss") != h.Origin {
		t.Fatalf("redirect: %s %v", decision.RedirectURI, err)
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {redirect.Query().Get("code")}, "client_id": {registration.ClientID}, "redirect_uri": {callback}, "resource": {h.Origin + "/mcp"}, "code_verifier": {verifier}}
	w = send("POST", "/oauth/token", form.Encode(), "application/x-www-form-urlencoded")
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &token); err != nil || w.Code != 200 || token.AccessToken == "" || token.RefreshToken == "" {
		t.Fatalf("token: %d %v", w.Code, err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcpPATClient(t, server.URL, token.AccessToken)
	if _, err := client.ListTools(ctx, nil); err != nil {
		t.Fatalf("OAuth MCP: %v", err)
	}
	rotate := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token.RefreshToken}, "client_id": {registration.ClientID}, "resource": {h.Origin + "/mcp"}}
	w = send("POST", "/oauth/token", rotate.Encode(), "application/x-www-form-urlencoded")
	var renewed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &renewed); err != nil || w.Code != http.StatusOK || renewed.AccessToken == "" || renewed.RefreshToken == "" || renewed.RefreshToken == token.RefreshToken {
		t.Fatalf("refresh: %d %v", w.Code, err)
	}
	revoke := url.Values{"token": {renewed.RefreshToken}, "client_id": {registration.ClientID}}
	w = send("POST", "/oauth/revoke", revoke.Encode(), "application/x-www-form-urlencoded")
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: %d", w.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+renewed.AccessToken)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked OAuth access status: %d", w.Code)
	}
}
