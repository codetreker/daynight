package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type deviceStartResponse struct {
	ExpectedUserID          string `json:"-"`
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

func (h *authHarness) form(path, body, contentType string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	return w
}
func deviceHTTPStart(t *testing.T, h *authHarness) deviceStartResponse {
	t.Helper()
	w := h.form("/api/v1/auth/device/code", "client_id=daynight-cli", "application/x-www-form-urlencoded")
	d := decodeResponse[deviceStartResponse](t, w, 200)
	if d.DeviceCode == "" || len(d.UserCode) != 11 || d.VerificationURI != h.auth.origin+"/device" || d.VerificationURIComplete != d.VerificationURI+"?user_code="+d.UserCode || d.ExpiresIn != 600 || d.Interval != 5 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("device response lost its code, URL, lifetime or cache contract")
	}
	if err := h.database.Pool.QueryRow(context.Background(), `SELECT id::text FROM users ORDER BY created_at,id LIMIT 1`).Scan(&d.ExpectedUserID); err != nil {
		t.Fatal(err)
	}
	return d
}
func deviceHTTPOAuthError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	failure := decodeResponse[struct {
		Error string `json:"error"`
	}](t, w, status)
	if failure.Error != code || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("OAuth failure: %d %+v", w.Code, failure)
	}
}
func (h *authHarness) poll(d deviceStartResponse) *httptest.ResponseRecorder {
	return h.form("/api/v1/auth/device/token", url.Values{"client_id": {service.DeviceClientID}, "grant_type": {service.DeviceGrantType}, "device_code": {d.DeviceCode}}.Encode(), "application/x-www-form-urlencoded")
}
func deviceBody(d deviceStartResponse, decision string) string {
	b, _ := json.Marshal(map[string]string{"userCode": d.UserCode, "decision": decision, "expectedUserId": d.ExpectedUserID})
	return string(b)
}

func TestDeviceHTTPApprovalRedemptionAndLogout(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "device-user")
	cookies := []*http.Cookie{cookie}
	d := deviceHTTPStart(t, h)
	deviceHTTPOAuthError(t, h.poll(d), 400, "slow_down")
	inspect := decodeResponse[service.DeviceInspection](t, h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, cookies, nil, h.auth.origin), 200)
	if inspect.Status != "pending" || inspect.UserCode != d.UserCode {
		t.Fatalf("inspection: %+v", inspect)
	}
	if w := h.request("POST", "/api/v1/auth/device/decision", deviceBody(d, "approve"), cookies, nil, h.auth.origin); w.Code != 204 {
		t.Fatalf("approval: %d %s", w.Code, w.Body)
	}
	if _, err := h.database.Pool.Exec(context.Background(), `UPDATE device_authorizations SET next_poll_at=$1`, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	response := decodeResponse[struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int    `json:"expires_in"`
	}](t, h.poll(d), 200)
	if !strings.HasPrefix(response.AccessToken, "dnpat_") || response.TokenType != "Bearer" || response.ExpiresIn != 2592000 {
		t.Fatal("invalid CLI credential response")
	}
	auth := []string{"Bearer " + response.AccessToken}
	me := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", nil, auth, ""), 200)
	if me.ID == "" {
		t.Fatal("issued credential cannot authenticate")
	}
	inspected := decodeResponse[service.DeviceInspection](t, h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, cookies, nil, h.auth.origin), 200)
	if inspected.Status != "consumed" {
		t.Fatalf("uncertain approval cannot reconcile: %+v", inspected)
	}
	deviceHTTPOAuthError(t, h.poll(d), 400, "invalid_grant")
	for _, path := range []string{"inspect", "decision"} {
		if w := h.request("POST", "/api/v1/auth/device/"+path, deviceBody(d, "approve"), nil, auth, ""); w.Code != 403 {
			t.Fatalf("PAT accessed browser endpoint: %d", w.Code)
		}
	}
	if w := h.request("POST", "/api/v1/auth/device/logout", "", cookies, nil, h.auth.origin); w.Code != 403 {
		t.Fatalf("browser invoked CLI logout: %d", w.Code)
	}
	if w := h.request("POST", "/api/v1/auth/device/logout", "", nil, auth, ""); w.Code != 204 {
		t.Fatalf("logout: %d %s", w.Code, w.Body)
	}
	if w := h.request("GET", "/api/v1/me", "", nil, auth, ""); w.Code != 401 {
		t.Fatal("logout did not revoke token")
	}
	if w := h.request("POST", "/api/v1/auth/device/logout", "", nil, auth, ""); w.Code != 401 {
		t.Fatal("revoked token authenticated")
	}
	for _, secret := range []string{d.DeviceCode, d.UserCode, response.AccessToken} {
		if strings.Contains(h.logs.String(), secret) {
			t.Fatal("device secret was logged")
		}
	}
}

func TestDeviceHTTPValidationAndBrowserOrigin(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "device-user")
	cookies := []*http.Cookie{cookie}
	d := deviceHTTPStart(t, h)
	for _, path := range []string{"inspect", "decision"} {
		for _, origin := range []string{"", "https://evil.example"} {
			if w := h.request("POST", "/api/v1/auth/device/"+path, deviceBody(d, "approve"), cookies, nil, origin); w.Code != 403 {
				t.Fatalf("cross-origin %s: %d", path, w.Code)
			}
		}
		if w := h.request("POST", "/api/v1/auth/device/"+path, deviceBody(d, "approve"), nil, nil, h.auth.origin); w.Code != 401 {
			t.Fatalf("anonymous %s: %d", path, w.Code)
		}
		for _, body := range []string{`{}`, `{"userCode":null}`, `{"userCode":"x","extra":true}`} {
			if w := h.request("POST", "/api/v1/auth/device/"+path, body, cookies, nil, h.auth.origin); w.Code != 400 {
				t.Fatalf("invalid browser input: %d %s", w.Code, w.Body)
			}
		}
	}
	for _, body := range []string{`{"userCode":"` + d.UserCode + `"}`, `{"userCode":"` + d.UserCode + `","decision":null}`, `{"userCode":"` + d.UserCode + `","decision":"other"}`} {
		if w := h.request("POST", "/api/v1/auth/device/decision", body, cookies, nil, h.auth.origin); w.Code != 400 {
			t.Fatalf("invalid decision input: %d", w.Code)
		}
	}
	for _, input := range []struct{ body, contentType string }{
		{"client_id=daynight-cli", "application/json"}, {"client_id=daynight-cli", "application/x-www-form-urlencoded;charset=latin1"}, {"client_id=daynight-cli&client_id=daynight-cli", "application/x-www-form-urlencoded"}, {"client_id=%zz", "application/x-www-form-urlencoded"}, {"client_id=\xff", "application/x-www-form-urlencoded"}, {"client_id=" + strings.Repeat("a", 4096), "application/x-www-form-urlencoded"}, {"", "application/x-www-form-urlencoded"},
	} {
		deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/code", input.body, input.contentType), 400, "invalid_request")
	}
	deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/code?client_id=x", "client_id=daynight-cli", "application/x-www-form-urlencoded"), 400, "invalid_request")
	deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/code", "client_id=other", "application/x-www-form-urlencoded"), 400, "invalid_client")
	deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/token", "client_id=daynight-cli", "application/x-www-form-urlencoded"), 400, "invalid_request")
	deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/token", "client_id=other&grant_type=x&device_code=x", "application/x-www-form-urlencoded"), 400, "invalid_client")
	deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/token", "client_id=daynight-cli&grant_type=x&device_code=x", "application/x-www-form-urlencoded"), 400, "unsupported_grant_type")
	deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/token", "client_id=daynight-cli&grant_type="+url.QueryEscape(service.DeviceGrantType)+"&device_code=x", "application/x-www-form-urlencoded"), 400, "invalid_grant")
	for _, path := range []string{"code", "token"} {
		w := h.request("GET", "/api/v1/auth/device/"+path, "", nil, nil, "")
		deviceHTTPOAuthError(t, w, 405, "invalid_request")
		if w.Header().Get("Allow") != "POST" {
			t.Fatal("missing Allow")
		}
	}
	for _, path := range []string{"inspect", "decision", "logout"} {
		if w := h.request("GET", "/api/v1/auth/device/"+path, "", cookies, nil, ""); w.Code != 405 || w.Header().Get("Allow") != "POST" {
			t.Fatalf("method contract: %d", w.Code)
		}
	}
	if source := deviceSource(&http.Request{RemoteAddr: "source-without-port"}); source != "source-without-port" {
		t.Fatalf("source: %s", source)
	}
}

func TestDeviceHTTPDeniedExpiredLimitsAndFailures(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "device-user")
	cookies := []*http.Cookie{cookie}
	d := deviceHTTPStart(t, h)
	if w := h.request("POST", "/api/v1/auth/device/decision", deviceBody(d, "deny"), cookies, nil, h.auth.origin); w.Code != 204 {
		t.Fatalf("deny: %d", w.Code)
	}
	deviceHTTPOAuthError(t, h.poll(d), 400, "access_denied")
	if w := h.request("POST", "/api/v1/auth/device/decision", deviceBody(d, "approve"), cookies, nil, h.auth.origin); w.Code != 409 {
		t.Fatalf("duplicate decision: %d", w.Code)
	}
	expired := deviceHTTPStart(t, h)
	if _, err := h.database.Pool.Exec(context.Background(), `UPDATE device_authorizations SET created_at=$1,expires_at=$2 WHERE user_code=$3`, time.Now().Add(-time.Hour), time.Now().Add(-time.Second), strings.ReplaceAll(expired.UserCode, "-", "")); err != nil {
		t.Fatal(err)
	}
	deviceHTTPOAuthError(t, h.poll(expired), 400, "expired_token")
	for range 10 {
		h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"BBBBB-BBBBB"}`, cookies, nil, h.auth.origin)
	}
	w := h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"BBBBB-BBBBB"}`, cookies, nil, h.auth.origin)
	failure := decodeResponse[api.ErrorResponse](t, w, 429)
	if failure.Error.Code != "rate_limited" || w.Header().Get("Retry-After") != "60" {
		t.Fatal("browser rate contract")
	}
	for range 28 {
		deviceHTTPStart(t, h)
	}
	w = h.form("/api/v1/auth/device/code", "client_id=daynight-cli", "application/x-www-form-urlencoded")
	deviceHTTPOAuthError(t, w, 429, "slow_down")
	if w.Header().Get("Retry-After") != "60" {
		t.Fatal("missing retry interval")
	}
	h.database.Close()
	deviceHTTPOAuthError(t, h.form("/api/v1/auth/device/code", "client_id=daynight-cli", "application/x-www-form-urlencoded"), 500, "server_error")
	deviceHTTPOAuthError(t, h.poll(d), 500, "server_error")
}

func TestDeviceHTTPAccountSwitchCannotApproveReviewedAccount(t *testing.T) {
	h := authTestHarness(t)
	alice := h.login(t, "alice")
	d := deviceHTTPStart(t, h)
	bob := h.login(t, "bob")
	inspect := decodeResponse[service.DeviceInspection](t, h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, []*http.Cookie{alice}, nil, h.auth.origin), 200)
	if inspect.Status != "pending" {
		t.Fatal("unexpected initial grant status")
	}
	if w := h.request("POST", "/api/v1/auth/device/decision", deviceBody(d, "approve"), []*http.Cookie{bob}, nil, h.auth.origin); w.Code != 403 {
		t.Fatalf("changed account decision: %d %s", w.Code, w.Body)
	}
	inspect = decodeResponse[service.DeviceInspection](t, h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, []*http.Cookie{alice}, nil, h.auth.origin), 200)
	if inspect.Status != "pending" {
		t.Fatal("changed account approved grant")
	}
}

func TestDevicePageRoutingAndCallbackProtection(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	for _, method := range []string{"GET", "HEAD"} {
		w := projectRequest(handler, method, "/device?user_code=BCDFG-HJKLM", "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
			t.Fatalf("device page routing: %d", w.Code)
		}
	}
	if strings.Contains(logs.String(), "BCDFG-HJKLM") {
		t.Fatal("device code leaked through page request log")
	}
	if w := projectRequest(handler, "POST", "/device", ""); w.Code != 405 {
		t.Fatalf("device page accepted write: %d", w.Code)
	}
	if w := projectRequest(handler, "GET", "/device/extra", ""); w.Code != 404 {
		t.Fatalf("device page routing overlap: %d", w.Code)
	}
	for _, path := range []string{"/device", "/device/callback", "/api/v1/auth/device/code", "/api/v1/auth/device/token"} {
		config := configuredTestConfig()
		config.UniAuthCallbackURL = config.PublicOrigin + path
		if err := config.Validate(); err == nil {
			t.Fatalf("device route accepted as callback: %s", path)
		}
	}
}

func TestDeviceHTTPInspectionNormalizesDatabaseTimeZone(t *testing.T) {
	h := authTestHarness(t)
	config := h.database.Pool.Config()
	config.MaxConns = 1
	config.MinConns = 0
	config.AfterConnect = func(_ context.Context, connection *pgx.Conn) error {
		connection.TypeMap().RegisterType(&pgtype.Type{Name: "timestamptz", OID: pgtype.TimestamptzOID, Codec: &pgtype.TimestamptzCodec{ScanLocation: time.FixedZone("UTC+08", 8*60*60)}})
		return nil
	}
	replacement, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	original := h.database.Pool
	h.database.Pool = replacement
	original.Close()
	cookie := h.login(t, "timezone-user")
	d := deviceHTTPStart(t, h)
	w := h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, []*http.Cookie{cookie}, nil, h.auth.origin)
	response := decodeResponse[struct {
		ExpiresAt string `json:"expiresAt"`
	}](t, w, 200)
	if !strings.HasSuffix(response.ExpiresAt, "Z") {
		t.Fatal("device inspection did not normalize a non-UTC database timestamp")
	}
}
