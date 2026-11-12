package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
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

func deviceHTTPForm(h *authHarness, path, body, contentType string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	h.Handler.ServeHTTP(w, r)
	return w
}
func deviceHTTPStart(t *testing.T, h *authHarness) deviceStartResponse {
	t.Helper()
	w := deviceHTTPForm(h, "/api/v1/auth/device/code", "client_id=daynight-cli", "application/x-www-form-urlencoded")
	d := testsupport.DecodeResponse[deviceStartResponse](t, w, 200)
	if d.DeviceCode == "" || len(d.UserCode) != 11 || d.VerificationURI != h.Origin+"/device" || d.VerificationURIComplete != d.VerificationURI+"?user_code="+d.UserCode || d.ExpiresIn != 600 || d.Interval != 5 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("device response lost its code, URL, lifetime or cache contract")
	}
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT id::text FROM users ORDER BY created_at,id LIMIT 1`).Scan(&d.ExpectedUserID); err != nil {
		t.Fatal(err)
	}
	return d
}
func deviceHTTPOAuthError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	failure := testsupport.DecodeResponse[struct {
		Error string `json:"error"`
	}](t, w, status)
	if failure.Error != code || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("OAuth failure: %d %+v", w.Code, failure)
	}
}
func deviceHTTPPoll(h *authHarness, d deviceStartResponse) *httptest.ResponseRecorder {
	return deviceHTTPForm(h, "/api/v1/auth/device/token", url.Values{"client_id": {identity.DeviceClientID}, "grant_type": {identity.DeviceGrantType}, "device_code": {d.DeviceCode}, "device_name": {"workstation"}}.Encode(), "application/x-www-form-urlencoded")
}
func deviceBody(d deviceStartResponse, decision string) string {
	b, _ := json.Marshal(map[string]string{"userCode": d.UserCode, "decision": decision, "expectedUserId": d.ExpectedUserID})
	return string(b)
}

func TestDeviceHTTPApprovalRedemptionAndLogout(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "device-user")
	cookies := []*http.Cookie{cookie}
	d := deviceHTTPStart(t, h)
	deviceHTTPOAuthError(t, deviceHTTPPoll(h, d), 400, "slow_down")
	inspect := testsupport.DecodeResponse[identity.DeviceInspection](t, h.Request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, cookies, nil, h.Origin), 200)
	if inspect.Status != "pending" || inspect.UserCode != d.UserCode {
		t.Fatalf("inspection: %+v", inspect)
	}
	if w := h.Request("POST", "/api/v1/auth/device/decision", deviceBody(d, "approve"), cookies, nil, h.Origin); w.Code != 204 {
		t.Fatalf("approval: %d %s", w.Code, w.Body)
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE device_authorizations SET next_poll_at=$1`, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	fields := url.Values{"client_id": {identity.DeviceClientID}, "grant_type": {identity.DeviceGrantType}, "device_code": {d.DeviceCode}}
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/token", fields.Encode(), "application/x-www-form-urlencoded"), 400, "invalid_request")
	for _, name := range []string{"", " ", "\xff", "host\x00name", "host\nname", strings.Repeat("界", 256)} {
		fields.Set("device_name", name)
		deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/token", fields.Encode(), "application/x-www-form-urlencoded"), 400, "invalid_request")
	}
	fields["device_name"] = []string{"workstation", "other-machine"}
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/token", fields.Encode(), "application/x-www-form-urlencoded"), 400, "invalid_request")
	tokenReply := deviceHTTPPoll(h, d)
	response := testsupport.DecodeResponse[struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   *int   `json:"expires_in"`
	}](t, tokenReply, 200)
	if !strings.HasPrefix(response.AccessToken, "dnpat_") || response.TokenType != "Bearer" || response.ExpiresIn != nil || strings.Contains(tokenReply.Body.String(), `"expires_in"`) {
		t.Fatal("invalid CLI credential response")
	}
	var deviceFields map[string]json.RawMessage
	if json.Unmarshal(tokenReply.Body.Bytes(), &deviceFields) != nil || len(deviceFields) != 2 || deviceFields["access_token"] == nil || deviceFields["token_type"] == nil {
		t.Fatalf("device token response fields: %v", deviceFields)
	}
	listResponse := h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, "")
	var initial struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if listResponse.Code != 200 || json.Unmarshal(listResponse.Body.Bytes(), &initial) != nil || len(initial.Items) != 1 || string(initial.Items[0]["lastUsedAt"]) != "null" || string(initial.Items[0]["name"]) != `"Daynight CLI (workstation)"` || strings.Contains(listResponse.Body.String(), response.AccessToken) {
		t.Fatalf("new device PAT metadata: %d %s", listResponse.Code, listResponse.Body)
	}
	auth := []string{"Bearer " + response.AccessToken}
	me := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", nil, auth, ""), 200)
	if me.ID == "" {
		t.Fatal("issued credential cannot authenticate")
	}
	listed := testsupport.DecodeResponse[api.PersonalAccessTokenList](t, h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, ""), 200)
	if len(listed.Items) != 1 || listed.Items[0].Name != "Daynight CLI (workstation)" {
		t.Fatalf("hostname not exposed in account token list: %+v", listed)
	}
	inspected := testsupport.DecodeResponse[identity.DeviceInspection](t, h.Request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, cookies, nil, h.Origin), 200)
	if inspected.Status != "consumed" {
		t.Fatalf("uncertain approval cannot reconcile: %+v", inspected)
	}
	deviceHTTPOAuthError(t, deviceHTTPPoll(h, d), 400, "invalid_grant")
	for _, path := range []string{"inspect", "decision"} {
		if w := h.Request("POST", "/api/v1/auth/device/"+path, deviceBody(d, "approve"), nil, auth, ""); w.Code != 403 {
			t.Fatalf("PAT accessed browser endpoint: %d", w.Code)
		}
	}
	if w := h.Request("POST", "/api/v1/auth/device/logout", "", cookies, nil, h.Origin); w.Code != 403 {
		t.Fatalf("browser invoked CLI logout: %d", w.Code)
	}
	if w := h.Request("POST", "/api/v1/auth/device/logout", "", nil, auth, ""); w.Code != 204 {
		t.Fatalf("logout: %d %s", w.Code, w.Body)
	}
	if w := h.Request("GET", "/api/v1/me", "", nil, auth, ""); w.Code != 401 {
		t.Fatal("logout did not revoke token")
	}
	if w := h.Request("POST", "/api/v1/auth/device/logout", "", nil, auth, ""); w.Code != 401 {
		t.Fatal("revoked token authenticated")
	}
	for _, secret := range []string{d.DeviceCode, d.UserCode, response.AccessToken} {
		if strings.Contains(h.Logs.String(), secret) {
			t.Fatal("device secret was logged")
		}
	}
}

func TestDeviceHTTPValidationAndBrowserOrigin(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "device-user")
	cookies := []*http.Cookie{cookie}
	d := deviceHTTPStart(t, h)
	for _, path := range []string{"inspect", "decision"} {
		for _, origin := range []string{"", "https://evil.example"} {
			if w := h.Request("POST", "/api/v1/auth/device/"+path, deviceBody(d, "approve"), cookies, nil, origin); w.Code != 403 {
				t.Fatalf("cross-origin %s: %d", path, w.Code)
			}
		}
		if w := h.Request("POST", "/api/v1/auth/device/"+path, deviceBody(d, "approve"), nil, nil, h.Origin); w.Code != 401 {
			t.Fatalf("anonymous %s: %d", path, w.Code)
		}
		for _, body := range []string{`{}`, `{"userCode":null}`, `{"userCode":"x","extra":true}`} {
			if w := h.Request("POST", "/api/v1/auth/device/"+path, body, cookies, nil, h.Origin); w.Code != 400 {
				t.Fatalf("invalid browser input: %d %s", w.Code, w.Body)
			}
		}
	}
	for _, body := range []string{`{"userCode":"` + d.UserCode + `"}`, `{"userCode":"` + d.UserCode + `","decision":null}`, `{"userCode":"` + d.UserCode + `","decision":"other"}`} {
		if w := h.Request("POST", "/api/v1/auth/device/decision", body, cookies, nil, h.Origin); w.Code != 400 {
			t.Fatalf("invalid decision input: %d", w.Code)
		}
	}
	for _, input := range []struct{ body, contentType string }{
		{"client_id=daynight-cli", "application/json"}, {"client_id=daynight-cli", "application/x-www-form-urlencoded;charset=latin1"}, {"client_id=daynight-cli&client_id=daynight-cli", "application/x-www-form-urlencoded"}, {"client_id=%zz", "application/x-www-form-urlencoded"}, {"client_id=\xff", "application/x-www-form-urlencoded"}, {"", "application/x-www-form-urlencoded"},
	} {
		deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/code", input.body, input.contentType), 400, "invalid_request")
	}
	if w := deviceHTTPForm(h, "/api/v1/auth/device/code", "client_id="+strings.Repeat("a", 4096), "application/x-www-form-urlencoded"); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized device form: %d %s", w.Code, w.Body)
	}
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/code?client_id=x", "client_id=daynight-cli", "application/x-www-form-urlencoded"), 400, "invalid_request")
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/code", "client_id=other", "application/x-www-form-urlencoded"), 400, "invalid_client")
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/token", "client_id=daynight-cli", "application/x-www-form-urlencoded"), 400, "invalid_request")
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/token", "client_id=other&grant_type=x&device_code=x&device_name=workstation", "application/x-www-form-urlencoded"), 400, "invalid_client")
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/token", "client_id=daynight-cli&grant_type=x&device_code=x&device_name=workstation", "application/x-www-form-urlencoded"), 400, "unsupported_grant_type")
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/token", "client_id=daynight-cli&grant_type="+url.QueryEscape(identity.DeviceGrantType)+"&device_code=x&device_name=workstation", "application/x-www-form-urlencoded"), 400, "invalid_grant")
	for _, path := range []string{"code", "token"} {
		w := h.Request("GET", "/api/v1/auth/device/"+path, "", nil, nil, "")
		deviceHTTPOAuthError(t, w, 405, "invalid_request")
		if w.Header().Get("Allow") != "POST" {
			t.Fatal("missing Allow")
		}
	}
	for _, path := range []string{"inspect", "decision", "logout"} {
		if w := h.Request("GET", "/api/v1/auth/device/"+path, "", cookies, nil, ""); w.Code != 405 || w.Header().Get("Allow") != "POST" {
			t.Fatalf("method contract: %d", w.Code)
		}
	}

}

func TestDeviceHTTPDeniedExpiredLimitsAndFailures(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "device-user")
	cookies := []*http.Cookie{cookie}
	d := deviceHTTPStart(t, h)
	if w := h.Request("POST", "/api/v1/auth/device/decision", deviceBody(d, "deny"), cookies, nil, h.Origin); w.Code != 204 {
		t.Fatalf("deny: %d", w.Code)
	}
	deviceHTTPOAuthError(t, deviceHTTPPoll(h, d), 400, "access_denied")
	if w := h.Request("POST", "/api/v1/auth/device/decision", deviceBody(d, "approve"), cookies, nil, h.Origin); w.Code != 409 {
		t.Fatalf("duplicate decision: %d", w.Code)
	}
	expired := deviceHTTPStart(t, h)
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE device_authorizations SET created_at=$1,expires_at=$2 WHERE user_code=$3`, time.Now().Add(-time.Hour), time.Now().Add(-time.Second), strings.ReplaceAll(expired.UserCode, "-", "")); err != nil {
		t.Fatal(err)
	}
	deviceHTTPOAuthError(t, deviceHTTPPoll(h, expired), 400, "expired_token")
	for range 10 {
		h.Request("POST", "/api/v1/auth/device/inspect", `{"userCode":"BBBBB-BBBBB"}`, cookies, nil, h.Origin)
	}
	w := h.Request("POST", "/api/v1/auth/device/inspect", `{"userCode":"BBBBB-BBBBB"}`, cookies, nil, h.Origin)
	failure := testsupport.DecodeResponse[api.ErrorResponse](t, w, 429)
	if failure.Error.Code != "rate_limited" || w.Header().Get("Retry-After") != "60" {
		t.Fatal("browser rate contract")
	}
	for range 28 {
		deviceHTTPStart(t, h)
	}
	w = deviceHTTPForm(h, "/api/v1/auth/device/code", "client_id=daynight-cli", "application/x-www-form-urlencoded")
	deviceHTTPOAuthError(t, w, 429, "slow_down")
	if w.Header().Get("Retry-After") != "60" {
		t.Fatal("missing retry interval")
	}
	h.Database.Close()
	deviceHTTPOAuthError(t, deviceHTTPForm(h, "/api/v1/auth/device/code", "client_id=daynight-cli", "application/x-www-form-urlencoded"), 500, "server_error")
	deviceHTTPOAuthError(t, deviceHTTPPoll(h, d), 500, "server_error")
}

func TestDeviceHTTPAccountSwitchCannotApproveReviewedAccount(t *testing.T) {
	h := authTestHarness(t)
	alice := h.Login(t, "alice")
	d := deviceHTTPStart(t, h)
	bob := h.Login(t, "bob")
	inspect := testsupport.DecodeResponse[identity.DeviceInspection](t, h.Request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, []*http.Cookie{alice}, nil, h.Origin), 200)
	if inspect.Status != "pending" {
		t.Fatal("unexpected initial grant status")
	}
	if w := h.Request("POST", "/api/v1/auth/device/decision", deviceBody(d, "approve"), []*http.Cookie{bob}, nil, h.Origin); w.Code != 403 {
		t.Fatalf("changed account decision: %d %s", w.Code, w.Body)
	}
	inspect = testsupport.DecodeResponse[identity.DeviceInspection](t, h.Request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, []*http.Cookie{alice}, nil, h.Origin), 200)
	if inspect.Status != "pending" {
		t.Fatal("changed account approved grant")
	}
}

func TestDeviceHTTPInspectionNormalizesDatabaseTimeZone(t *testing.T) {
	h := authTestHarness(t)
	config := h.Database.Pool.Config()
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
	original := h.Database.Pool
	h.Database.Pool = replacement
	original.Close()
	cookie := h.Login(t, "timezone-user")
	d := deviceHTTPStart(t, h)
	w := h.Request("POST", "/api/v1/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, []*http.Cookie{cookie}, nil, h.Origin)
	response := testsupport.DecodeResponse[struct {
		ExpiresAt string `json:"expiresAt"`
	}](t, w, 200)
	if !strings.HasSuffix(response.ExpiresAt, "Z") {
		t.Fatal("device inspection did not normalize a non-UTC database timestamp")
	}
}
