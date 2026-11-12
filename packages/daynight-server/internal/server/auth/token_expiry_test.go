package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/google/uuid"
)

func createHTTPPAT(t *testing.T, h *authHarness, cookie *http.Cookie, expiry *time.Time) api.CreatedPersonalAccessToken {
	t.Helper()
	return testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t, h.Request("POST", "/api/v1/me/tokens", testsupport.JSONBody(t, map[string]any{"name": "Editable token", "expiresAt": expiry}), []*http.Cookie{cookie}, nil, h.Origin), 201)
}

func TestTokenExpiryHTTPCreateEditAndCurrentBearer(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "editable-user")
	cookies := []*http.Cookie{cookie}
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 200)
	minted := createHTTPPAT(t, h, cookie, nil)
	if minted.ExpiresAt != nil {
		t.Fatal("manual token did not default to explicit no expiration")
	}
	deadline := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": deadline, "expectedExpiresAt": nil, "expectedUserId": user.ID})
	response := h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin)
	changed := testsupport.DecodeResponse[api.PersonalAccessToken](t, response, 200)
	if changed.ID != minted.ID || changed.Name != minted.Name || changed.ExpiresAt == nil || !changed.ExpiresAt.Equal(deadline) || !changed.CreatedAt.Equal(minted.CreatedAt) {
		t.Fatal("expiry edit changed token identity or metadata")
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != user.ID {
		t.Fatal("token mutation lost cache or actual-principal boundary")
	}
	if !strings.Contains(response.Body.String(), `"expiresAt":"`+deadline.Format(time.RFC3339Nano)+`"`) {
		t.Fatal("token expiry response was not UTC")
	}
	bearer := []string{"Bearer " + minted.Token}
	if actual := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", nil, bearer, ""), 200); actual.ID != user.ID {
		t.Fatal("expiry edit invalidated original bearer")
	}
	var stored []byte
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT token_hash FROM personal_access_tokens WHERE id=$1`, minted.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	expectedHash := sha256.Sum256([]byte(minted.Token))
	if !bytes.Equal(stored, expectedHash[:]) {
		t.Fatal("expiry mutation changed secret hash")
	}
	testsupport.AssertProjectError(t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin), 409, "version_conflict")
	body = testsupport.JSONBody(t, map[string]any{"expiresAt": nil, "expectedExpiresAt": deadline, "expectedUserId": user.ID})
	removed := testsupport.DecodeResponse[api.PersonalAccessToken](t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin), 200)
	if removed.ExpiresAt != nil {
		t.Fatal("expiry removal failed")
	}
	noop := testsupport.JSONBody(t, map[string]any{"expiresAt": nil, "expectedExpiresAt": nil, "expectedUserId": user.ID})
	testsupport.DecodeResponse[api.PersonalAccessToken](t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, noop, cookies, nil, h.Origin), 200)
	finite := createHTTPPAT(t, h, cookie, &deadline)
	if finite.ExpiresAt == nil || !finite.ExpiresAt.Equal(deadline) {
		t.Fatal("finite token creation did not preserve selected future expiry")
	}
	listed := testsupport.DecodeResponse[api.PersonalAccessTokenList](t, h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, ""), 200)
	if len(listed.Items) != 2 {
		t.Fatal("finite or nonexpiring token missing from management")
	}
	if strings.Contains(h.Logs.String(), minted.Token) || strings.Contains(h.Logs.String(), finite.Token) {
		t.Fatal("expiry management logged token secret")
	}
}

func TestTokenExpiryResponseDoesNotExposeUsageTime(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "metadata-user")
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{cookie}, nil, ""), 200)
	token := createHTTPPAT(t, h, cookie, nil)
	now := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := h.Database.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET last_used_at=$2 WHERE id=$1`, token.ID, now); err != nil {
		t.Fatal(err)
	}
	expiry := now.Add(time.Hour)
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": expiry, "expectedExpiresAt": nil, "expectedUserId": user.ID})
	patch := h.Request("PATCH", "/api/v1/me/tokens/"+token.ID, body, []*http.Cookie{cookie}, nil, h.Origin)
	var changed map[string]json.RawMessage
	if patch.Code != http.StatusOK || json.Unmarshal(patch.Body.Bytes(), &changed) != nil {
		t.Fatalf("patch: %d %s", patch.Code, patch.Body)
	}
	want := []string{"id", "name", "createdAt", "expiresAt"}
	if len(changed) != len(want) {
		t.Fatalf("unexpected metadata fields: %v", changed)
	}
	for _, field := range want {
		if _, ok := changed[field]; !ok {
			t.Fatalf("missing metadata field %s: %v", field, changed)
		}
	}
}

func TestTokenExpiryHTTPValidationOwnershipAndAccountSwitch(t *testing.T) {
	h := authTestHarness(t)
	alice := h.Login(t, "alice")
	aliceCookies := []*http.Cookie{alice}
	aliceUser := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", aliceCookies, nil, ""), 200)
	minted := createHTTPPAT(t, h, alice, nil)
	bob := h.Login(t, "bob")
	bobCookies := []*http.Cookie{bob}
	bobUser := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", bobCookies, nil, ""), 200)
	path := "/api/v1/me/tokens/" + minted.ID
	future := time.Now().UTC().Add(time.Hour)
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": future, "expectedExpiresAt": nil, "expectedUserId": aliceUser.ID})
	testsupport.AssertProjectError(t, h.Request("PATCH", path, body, bobCookies, nil, h.Origin), 403, "forbidden")
	listed := testsupport.DecodeResponse[api.PersonalAccessTokenList](t, h.Request("GET", "/api/v1/me/tokens", "", aliceCookies, nil, ""), 200)
	if len(listed.Items) != 1 || listed.Items[0].ExpiresAt != nil {
		t.Fatal("changed account mutated reviewed credential")
	}
	for _, origin := range []string{"", "https://foreign.example"} {
		testsupport.AssertProjectError(t, h.Request("PATCH", path, body, aliceCookies, nil, origin), 403, "forbidden")
	}
	testsupport.AssertProjectError(t, h.Request("PATCH", path, body, nil, nil, h.Origin), 401, "unauthenticated")
	testsupport.AssertProjectError(t, h.Request("PATCH", path, body, nil, []string{"Bearer " + minted.Token}, ""), 403, "forbidden")
	bodyOther := testsupport.JSONBody(t, map[string]any{"expiresAt": future, "expectedExpiresAt": nil, "expectedUserId": bobUser.ID})
	testsupport.AssertProjectError(t, h.Request("PATCH", path, bodyOther, bobCookies, nil, h.Origin), 404, "not_found")
	for _, invalid := range []string{
		`{}`, `{"expiresAt":null}`, `{"expiresAt":null,"expectedExpiresAt":null}`, `{"expiresAt":null,"expectedExpiresAt":null,"expectedUserId":null}`, `{"expiresAt":null,"expectedExpiresAt":null,"expectedUserId":"bad"}`, `{"expiresAt":null,"expectedExpiresAt":7,"expectedUserId":"` + aliceUser.ID + `"}`, `{"expiresAt":false,"expectedExpiresAt":null,"expectedUserId":"` + aliceUser.ID + `"}`, `{"expiresAt":"invalidZ","expectedExpiresAt":null,"expectedUserId":"` + aliceUser.ID + `"}`, `{"expiresAt":"2030-01-01T00:00:00+00:00","expectedExpiresAt":null,"expectedUserId":"` + aliceUser.ID + `"}`, `{"expiresAt":"2020-01-01T00:00:00Z","expectedExpiresAt":null,"expectedUserId":"` + aliceUser.ID + `"}`, `{"expiresAt":null,"expectedExpiresAt":null,"expectedUserId":"` + aliceUser.ID + `","extra":true}`,
	} {
		testsupport.AssertProjectError(t, h.Request("PATCH", path, invalid, aliceCookies, nil, h.Origin), 400, "invalid_input")
	}
	for _, invalid := range []string{`{"name":"missing"}`, `{"name":"legacy","days":30}`, `{"name":"bad","expiresAt":7}`, `{"name":"bad","expiresAt":"2020-01-01T00:00:00Z"}`, `{"name":"bad","expiresAt":"2030-01-01T00:00:00+08:00"}`} {
		testsupport.AssertProjectError(t, h.Request("POST", "/api/v1/me/tokens", invalid, aliceCookies, nil, h.Origin), 400, "invalid_input")
	}
	testsupport.AssertProjectError(t, h.Request("PATCH", "/api/v1/me/tokens/invalid", body, aliceCookies, nil, h.Origin), 400, "invalid_input")
	testsupport.AssertProjectError(t, h.Request("PATCH", "/api/v1/me/tokens/"+uuid.NewString(), body, aliceCookies, nil, h.Origin), 404, "not_found")
	if w := h.Request("GET", path, "", aliceCookies, nil, ""); w.Code != 405 || w.Header().Get("Allow") != "PATCH, DELETE" {
		t.Fatal("token metadata method contract changed")
	}
	if w := h.Request("DELETE", path, "", aliceCookies, nil, h.Origin); w.Code != 204 {
		t.Fatal("token revocation failed")
	}
	testsupport.AssertProjectError(t, h.Request("PATCH", path, body, aliceCookies, nil, h.Origin), 404, "not_found")
}

func TestTokenExpiryHTTPExpiredAndOperationalFailure(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "edit-user")
	cookies := []*http.Cookie{cookie}
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 200)
	minted := createHTTPPAT(t, h, cookie, nil)
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE personal_access_tokens SET created_at=$2,expires_at=$3 WHERE id=$1`, minted.ID, time.Now().Add(-time.Hour), time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": nil, "expectedExpiresAt": nil, "expectedUserId": user.ID})
	testsupport.AssertProjectError(t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin), 404, "not_found")
	if _, err := h.Database.Pool.Exec(context.Background(), `DROP TABLE personal_access_tokens`); err != nil {
		t.Fatal(err)
	}
	testsupport.AssertProjectError(t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin), 500, "internal_error")
}
