//go:build integration

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

type usageTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

// usageRequest deliberately omits response bodies from diagnostics: token
// issuance responses contain secrets.
func usageRequest(t *testing.T, f *fixture, client *http.Client, method, path, body, contentType, bearer string, status int) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(f.context, method, f.origin+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if method == http.MethodPost || method == http.MethodPatch {
		req.Header.Set("Origin", f.origin)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if path == "/mcp" {
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, req.URL.Path, err)
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	closeErr := resp.Body.Close()
	if readErr != nil || closeErr != nil || resp.StatusCode != status {
		t.Fatalf("%s %s: HTTP %d (want %d), read=%v close=%v", method, req.URL.Path, resp.StatusCode, status, readErr, closeErr)
	}
	return resp, data
}

func usageDecode[T any](t *testing.T, data []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatalf("decode credential response: %v", err)
	}
	return value
}

func usageTimestamp(t *testing.T, entry map[string]json.RawMessage) *time.Time {
	t.Helper()
	value, present := entry["lastUsedAt"]
	if !present {
		t.Fatal("lastUsedAt is missing")
	}
	if bytes.Equal(value, []byte("null")) {
		return nil
	}
	var timestamp time.Time
	if err := json.Unmarshal(value, &timestamp); err != nil || timestamp.IsZero() {
		t.Fatalf("invalid lastUsedAt: %s (%v)", value, err)
	}
	return &timestamp
}

func usageString(t *testing.T, entry map[string]json.RawMessage, field string) string {
	t.Helper()
	var result string
	if err := json.Unmarshal(entry[field], &result); err != nil || result == "" {
		t.Fatalf("missing or invalid %s", field)
	}
	return result
}

func usageFind(t *testing.T, entries []map[string]json.RawMessage, id string) map[string]json.RawMessage {
	t.Helper()
	for _, entry := range entries {
		if usageString(t, entry, "id") == id {
			return entry
		}
	}
	t.Fatalf("credential %s missing from owner list", id)
	return nil
}

func usageWait(t *testing.T, f *fixture, read func() *time.Time, after *time.Time, from, until time.Time) time.Time {
	t.Helper()
	deadline := time.NewTimer(60 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if value := read(); value != nil && (after == nil || value.After(*after)) {
			// Client and Server share the machine clock, but allow a small clock
			// adjustment while still tying the timestamp to this request.
			if value.Before(from.Add(-2*time.Second)) || value.After(until.Add(2*time.Second)) {
				t.Fatalf("recorded event %s outside request interval %s–%s", value, from, until)
			}
			return *value
		}
		select {
		case <-f.context.Done():
			t.Fatal(f.context.Err())
		case <-deadline.C:
			t.Fatal("credential usage did not become visible within 60 seconds")
		case <-ticker.C:
		}
	}
}

func TestServerAPICredentialUsageNormalFlow(t *testing.T) {
	f := newFixture(t)
	browser := testauth.Browser(t)
	testauth.Login(t, browser, f.origin, "alice")
	plain := &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(plain.CloseIdleConnections)

	_, data := usageRequest(t, f, browser, http.MethodPost, "/api/v1/me/tokens", `{"name":"Usage integration","expiresAt":null}`, "application/json", "", http.StatusCreated)
	created := usageDecode[map[string]json.RawMessage](t, data)
	patID, pat := usageString(t, created, "id"), usageString(t, created, "token")
	if usageTimestamp(t, created) != nil {
		t.Fatal("new PAT already has a usage event")
	}
	readPAT := func() *time.Time {
		_, data := usageRequest(t, f, browser, http.MethodGet, "/api/v1/me/tokens", "", "", "", http.StatusOK)
		if bytes.Contains(data, []byte(pat)) || bytes.Contains(data, []byte("token_hash")) {
			t.Fatal("PAT list exposed credential material")
		}
		list := usageDecode[struct {
			Items []map[string]json.RawMessage `json:"items"`
		}](t, data)
		return usageTimestamp(t, usageFind(t, list.Items, patID))
	}
	if readPAT() != nil {
		t.Fatal("listing a new PAT invented a usage event")
	}
	patStart := time.Now()
	_, data = usageRequest(t, f, plain, http.MethodGet, "/api/v1/me", "", "", pat, http.StatusOK)
	patEnd := time.Now()
	if user := usageDecode[struct {
		ID string `json:"id"`
	}](t, data); user.ID != f.userID {
		t.Fatal("PAT authenticated the wrong user")
	}
	usageWait(t, f, readPAT, nil, patStart, patEnd)

	const callback = "http://127.0.0.1:9012/callback"
	_, data = usageRequest(t, f, plain, http.MethodPost, "/oauth/register", `{"client_name":"Usage integration","redirect_uris":["http://127.0.0.1:9012/callback"]}`, "application/json", "", http.StatusCreated)
	registration := usageDecode[struct {
		ClientID string `json:"client_id"`
		Method   string `json:"token_endpoint_auth_method"`
	}](t, data)
	if registration.ClientID == "" || registration.Method != "none" {
		t.Fatal("OAuth client registration did not return a public client")
	}
	verifier := strings.Repeat("v", 43)
	challenge := sha256.Sum256([]byte(verifier))
	query := url.Values{"client_id": {registration.ClientID}, "redirect_uri": {callback}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {f.origin + "/mcp"}, "state": {"usage-state"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
	start, _ := usageRequest(t, f, browser, http.MethodGet, "/oauth/authorize?"+query.Encode(), "", "", "", http.StatusSeeOther)
	location, err := start.Location()
	if err != nil || location.Path != "/oauth/consent" || location.Query().Get("request") == "" {
		t.Fatal("OAuth authorization did not return a consent request")
	}
	requestID := location.Query().Get("request")
	_, data = usageRequest(t, f, browser, http.MethodGet, "/api/v1/oauth/requests/"+requestID, "", "", "", http.StatusOK)
	inspection := usageDecode[struct {
		UserID string `json:"userId"`
		Status string `json:"status"`
	}](t, data)
	if inspection.UserID != f.userID || inspection.Status != "pending" {
		t.Fatal("consent request belongs to a different user or is not pending")
	}
	decision, err := json.Marshal(map[string]string{"expectedUserId": f.userID, "decision": "approve"})
	if err != nil {
		t.Fatal(err)
	}
	_, data = usageRequest(t, f, browser, http.MethodPost, "/api/v1/oauth/requests/"+requestID+"/decision", string(decision), "application/json", "", http.StatusOK)
	approved := usageDecode[struct {
		RedirectURI string `json:"redirectUri"`
	}](t, data)
	redirect, err := url.Parse(approved.RedirectURI)
	if err != nil || redirect.Scheme+"://"+redirect.Host+redirect.Path != callback || redirect.Query().Get("state") != "usage-state" || redirect.Query().Get("code") == "" {
		t.Fatal("OAuth approval returned an invalid redirect")
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {redirect.Query().Get("code")}, "client_id": {registration.ClientID}, "redirect_uri": {callback}, "resource": {f.origin + "/mcp"}, "code_verifier": {verifier}}
	_, data = usageRequest(t, f, plain, http.MethodPost, "/oauth/token", form.Encode(), "application/x-www-form-urlencoded", "", http.StatusOK)
	tokens := usageDecode[usageTokens](t, data)
	if tokens.AccessToken == "" || tokens.RefreshToken == "" {
		t.Fatal("OAuth issuance did not return both tokens")
	}

	readGrants := func() []map[string]json.RawMessage {
		resp, data := usageRequest(t, f, browser, http.MethodGet, "/api/v2/oauth/grants", "", "", "", http.StatusOK)
		if resp.Header.Get("Daynight-User-ID") != f.userID || !strings.Contains(resp.Header.Get("Cache-Control"), "no-store") {
			t.Fatal("grant list owner or cache policy differs")
		}
		if bytes.Contains(data, []byte(tokens.AccessToken)) || bytes.Contains(data, []byte(tokens.RefreshToken)) || bytes.Contains(data, []byte("token_hash")) {
			t.Fatal("grant list exposed credential material")
		}
		result := usageDecode[struct {
			UserID string                       `json:"userId"`
			Grants []map[string]json.RawMessage `json:"grants"`
		}](t, data)
		if result.UserID != f.userID {
			t.Fatal("grant list belongs to a different user")
		}
		return result.Grants
	}
	grants := readGrants()
	var grantID string
	for _, grant := range grants {
		if usageString(t, grant, "clientId") == registration.ClientID {
			if grantID != "" {
				t.Fatal("multiple grants for the new authorization")
			}
			grantID = usageString(t, grant, "id")
			if usageTimestamp(t, grant) != nil {
				t.Fatal("new grant already has a usage event")
			}
		}
	}
	if grantID == "" {
		t.Fatal("issued grant missing from owner list")
	}
	readGrant := func() *time.Time { return usageTimestamp(t, usageFind(t, readGrants(), grantID)) }

	accessStart := time.Now()
	_, data = usageRequest(t, f, plain, http.MethodPost, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`, "application/json", tokens.AccessToken, http.StatusOK)
	accessEnd := time.Now()
	result := usageDecode[struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}](t, data)
	if len(result.Result) == 0 || len(result.Error) != 0 {
		t.Fatal("OAuth MCP tools/list did not succeed")
	}
	accessAt := usageWait(t, f, readGrant, nil, accessStart, accessEnd)
	refresh := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}, "client_id": {registration.ClientID}, "resource": {f.origin + "/mcp"}}
	refreshStart := time.Now()
	_, data = usageRequest(t, f, plain, http.MethodPost, "/oauth/token", refresh.Encode(), "application/x-www-form-urlencoded", "", http.StatusOK)
	refreshEnd := time.Now()
	renewed := usageDecode[usageTokens](t, data)
	if renewed.AccessToken == "" || renewed.RefreshToken == "" || renewed.RefreshToken == tokens.RefreshToken {
		t.Fatal("OAuth refresh did not rotate the credential")
	}
	usageWait(t, f, readGrant, &accessAt, refreshStart, refreshEnd)
	if len(readGrants()) != len(grants) {
		t.Fatal("refresh changed the grant list membership")
	}
}
