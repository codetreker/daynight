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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

func scopedDeviceBody(t *testing.T, h *authHarness, d deviceStartResponse, decision string) string {
	t.Helper()
	body := map[string]any{"userCode": d.UserCode, "decision": decision, "expectedUserId": d.ExpectedUserID}
	if decision == "approve" {
		catalog, enabled := h.Identity.DeviceScopeCatalog()
		if !enabled {
			t.Fatal("PAT scope catalog is unavailable")
		}
		body["catalogRevision"] = catalog.CatalogRevision
		body["scopes"] = []string{"task:read"}
	}
	return testsupport.JSONBody(t, body)
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
	if w := h.Request("POST", "/api/v2/auth/device/decision", scopedDeviceBody(t, h, d, "approve"), cookies, nil, h.Origin); w.Code != 204 {
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
		t.Fatal("device token response does not have exactly access_token and token_type")
	}
	listResponse := h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, "")
	var initial struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if listResponse.Code != 200 || json.Unmarshal(listResponse.Body.Bytes(), &initial) != nil || len(initial.Items) != 1 || string(initial.Items[0]["lastUsedAt"]) != "null" || string(initial.Items[0]["name"]) != `"Daynight CLI (workstation)"` || strings.Contains(listResponse.Body.String(), response.AccessToken) {
		t.Fatalf("new device PAT metadata is invalid: HTTP %d", listResponse.Code)
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
	h := newStrictAuthHTTP(t)
	actor, _ := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	cookies := []*http.Cookie{cookie}
	admit := expectAuthentication(actor, cookie.Value)
	const source = "192.0.2.42"
	const formType = "application/x-www-form-urlencoded"
	const codePath = "/api/v1/auth/device/code"
	const tokenPath = "/api/v1/auth/device/token"
	form := func(path, body, contentType string, calls ...authRequestCall) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", path, strings.NewReader(body))
		request.RemoteAddr = source + ":58443"
		request.Header.Set("Content-Type", contentType)
		return h.serve(request, calls...)
	}

	start := identity.DeviceStart{DeviceCode: strings.Repeat("A", 43), UserCode: "BCDFG-HJKLM"}
	started := form(codePath, "client_id=daynight-cli", formType,
		authRequestCall{name: "StartDevice", args: []any{identity.DeviceClientID, source}, result: start})
	d := testsupport.DecodeResponse[deviceStartResponse](t, started, http.StatusOK)
	if d.DeviceCode != start.DeviceCode || d.UserCode != start.UserCode || d.VerificationURI != authRequestOrigin+"/device" ||
		d.VerificationURIComplete != d.VerificationURI+"?user_code="+d.UserCode || d.ExpiresIn != 600 || d.Interval != 5 ||
		started.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("device response lost its code, URL, lifetime or cache contract")
	}
	d.ExpectedUserID = actor.UserID

	for _, path := range []string{"inspect", "decision"} {
		route := "/api/v1/auth/device/" + path
		for _, origin := range []string{"", "https://evil.example"} {
			response := h.request("POST", route, deviceBody(d, "approve"), cookies, nil, origin, admit)
			testsupport.AssertProjectError(t, response, http.StatusForbidden, "forbidden")
			if response.Header().Get("Daynight-User-ID") != "" {
				t.Fatalf("rejected Origin advertised a principal: %s", path)
			}
		}
		response := h.request("POST", route, deviceBody(d, "approve"), nil, nil, authRequestOrigin)
		testsupport.AssertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
		for _, body := range []string{`{}`, `{"userCode":null}`, `{"userCode":"x","extra":true}`} {
			response := h.request("POST", route, body, cookies, nil, authRequestOrigin, admit)
			testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		}
	}
	const decisionPath = "/api/v1/auth/device/decision"
	for _, body := range []string{`{"userCode":"` + d.UserCode + `"}`, `{"userCode":"` + d.UserCode + `","decision":null}`, `{"userCode":"` + d.UserCode + `","decision":"other"}`} {
		response := h.request("POST", decisionPath, body, cookies, nil, authRequestOrigin, admit)
		testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	response := h.request("POST", decisionPath, deviceBody(d, "other"), cookies, nil, authRequestOrigin, admit,
		authRequestCall{name: "DecideDevice", args: []any{actor, d.UserCode, "other", actor.UserID},
			err: &model.Fault{Code: "invalid_input", Message: "decision must be approve or deny"}})
	testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	response = h.request("POST", "/api/v1/auth/device/inspect", `{"userCode":"x"}`, cookies, nil, authRequestOrigin, admit,
		authRequestCall{name: "InspectDevice", args: []any{actor, "x"},
			err: &model.Fault{Code: "invalid_input", Message: "Enter the ten-letter device code shown by the CLI."}})
	testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")

	for _, input := range []struct{ body, contentType string }{
		{"client_id=daynight-cli", "application/json"},
		{"client_id=daynight-cli", "application/x-www-form-urlencoded;charset=latin1"},
		{"client_id=daynight-cli&client_id=daynight-cli", formType},
		{"client_id=%zz", formType},
		{"client_id=" + string([]byte{0xff}), formType},
		{"", formType},
	} {
		deviceHTTPOAuthError(t, form(codePath, input.body, input.contentType), http.StatusBadRequest, "invalid_request")
	}
	if w := form(codePath, "client_id="+strings.Repeat("a", 4096), formType); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized device form: %d %s", w.Code, w.Body)
	}
	deviceHTTPOAuthError(t, form(codePath+"?client_id=x", "client_id=daynight-cli", formType), http.StatusBadRequest, "invalid_request")
	deviceHTTPOAuthError(t, form(codePath, "client_id=other", formType,
		authRequestCall{name: "StartDevice", args: []any{"other", source}, err: &identity.DeviceGrantError{Code: "invalid_client"}}), http.StatusBadRequest, "invalid_client")
	deviceHTTPOAuthError(t, form(tokenPath, "client_id=daynight-cli", formType), http.StatusBadRequest, "invalid_request")
	for _, input := range []struct{ client, grant, failure string }{
		{"other", "x", "invalid_client"},
		{identity.DeviceClientID, "x", "unsupported_grant_type"},
		{identity.DeviceClientID, identity.DeviceGrantType, "invalid_grant"},
	} {
		body := "client_id=" + input.client + "&grant_type=" + url.QueryEscape(input.grant) + "&device_code=x&device_name=workstation"
		response := form(tokenPath, body, formType, authRequestCall{
			name: "RedeemDevice", args: []any{input.client, input.grant, "x", "workstation"}, err: &identity.DeviceGrantError{Code: input.failure},
		})
		deviceHTTPOAuthError(t, response, http.StatusBadRequest, input.failure)
	}
	for _, path := range []string{codePath, tokenPath} {
		w := h.request("GET", path, "", nil, nil, "")
		deviceHTTPOAuthError(t, w, http.StatusMethodNotAllowed, "invalid_request")
		if w.Header().Get("Allow") != "POST" {
			t.Fatal("missing Allow")
		}
	}
	for _, path := range []string{"inspect", "decision", "logout"} {
		if w := h.request("GET", "/api/v1/auth/device/"+path, "", cookies, nil, "", admit); w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST" {
			t.Fatalf("method contract: %d", w.Code)
		}
	}
}

func TestDeviceHTTPDeniedExpiredLimitsAndFailures(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "device-user")
	cookies := []*http.Cookie{cookie}
	d := deviceHTTPStart(t, h)
	if w := h.Request("POST", "/api/v2/auth/device/decision", scopedDeviceBody(t, h, d, "deny"), cookies, nil, h.Origin); w.Code != 204 {
		t.Fatalf("deny: %d", w.Code)
	}
	deviceHTTPOAuthError(t, deviceHTTPPoll(h, d), 400, "access_denied")
	if w := h.Request("POST", "/api/v2/auth/device/decision", scopedDeviceBody(t, h, d, "approve"), cookies, nil, h.Origin); w.Code != 409 {
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
	if w := h.Request("POST", "/api/v2/auth/device/decision", scopedDeviceBody(t, h, d, "approve"), []*http.Cookie{bob}, nil, h.Origin); w.Code != 403 {
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
