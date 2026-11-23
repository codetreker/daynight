//go:build integration

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type applicationTokens struct {
	AccessToken     string    `json:"access_token"`
	TokenType       string    `json:"token_type"`
	ExpiresIn       int       `json:"expires_in"`
	AccessExpiresAt time.Time `json:"access_expires_at"`
	RefreshToken    string    `json:"refresh_token"`
	GrantExpiresAt  time.Time `json:"grant_expires_at"`
	Scope           string    `json:"scope"`
	Resource        string    `json:"resource"`
	ClientID        string    `json:"client_id"`
	GrantID         string    `json:"grant_id"`
	UserID          string    `json:"user_id"`
}

type applicationGrant struct {
	ID         string     `json:"id"`
	ClientName string     `json:"clientName"`
	ClientID   string     `json:"clientId"`
	Resource   string     `json:"resource"`
	Scope      string     `json:"scope"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	RevokedAt  *time.Time `json:"revokedAt"`
	Status     string     `json:"status"`
}

// Token-bearing requests omit headers and bodies from failure diagnostics.
func applicationRequest(t *testing.T, f *fixture, client *http.Client, path, body, media, authorization string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(f.context, http.MethodPost, f.origin+path, strings.NewReader(body))
	if err != nil {
		t.Fatal("construct application authorization request failed")
	}
	request.Header.Set("Content-Type", media)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: application authorization transport failed", path)
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err := errors.Join(readErr, response.Body.Close()); err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("POST %s: HTTP %d, want 200; response read failed=%t", path, response.StatusCode, err != nil)
	}
	return response, data
}

func applicationTokenResponse(t *testing.T, f *fixture, response *http.Response, data []byte) applicationTokens {
	t.Helper()
	if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Pragma") != "no-cache" || response.Header.Get("Location") != "" {
		t.Fatal("application token response cache policy or Location differs")
	}
	var fields map[string]json.RawMessage
	var tokens applicationTokens
	if json.Unmarshal(data, &fields) != nil || json.Unmarshal(data, &tokens) != nil || len(fields) != 11 {
		t.Fatal("application token response does not have the exact DTO")
	}
	for _, field := range []string{"access_token", "token_type", "expires_in", "access_expires_at", "refresh_token", "grant_expires_at", "scope", "resource", "client_id", "grant_id", "user_id"} {
		if _, present := fields[field]; !present {
			t.Fatalf("application token response is missing %s", field)
		}
	}
	for field, prefix := range map[string]string{"access_token": "dnapi_", "refresh_token": "dnapr_"} {
		var value string
		if json.Unmarshal(fields[field], &value) != nil || !strings.HasPrefix(value, prefix) {
			t.Fatalf("application %s prefix differs", field)
		}
		secret := strings.TrimPrefix(value, prefix)
		raw, err := base64.RawURLEncoding.DecodeString(secret)
		if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != secret {
			t.Fatalf("application %s is not a canonical 32-byte secret", field)
		}
	}
	utcMicrosecond := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$`)
	for _, field := range []string{"access_expires_at", "grant_expires_at"} {
		var value string
		if json.Unmarshal(fields[field], &value) != nil || !utcMicrosecond.MatchString(value) {
			t.Fatalf("application %s is not a UTC microsecond deadline", field)
		}
	}
	for _, id := range []string{tokens.GrantID, tokens.UserID} {
		parsed, err := uuid.Parse(id)
		if err != nil || parsed == uuid.Nil || parsed.String() != id {
			t.Fatal("application response contains a noncanonical identity")
		}
	}
	if tokens.TokenType != "Bearer" || tokens.ExpiresIn != 3600 || tokens.Scope != "daynight:api" || tokens.ClientID != "societas-bot" || tokens.Resource != f.origin+"/api/v1" || tokens.UserID != f.userID {
		t.Fatal("application token binding or lifetime differs")
	}
	if tokens.AccessExpiresAt.IsZero() || tokens.GrantExpiresAt.Sub(tokens.AccessExpiresAt) != 30*24*time.Hour-time.Hour {
		t.Fatal("application access and grant deadlines do not share the issuing instant")
	}
	return tokens
}

func serverAPIPublicApplicationNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	browser := testauth.Browser(t)
	testauth.Login(t, browser, f.origin, "alice")
	plain := &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(plain.CloseIdleConnections)
	_, data := usageRequest(t, f, browser, http.MethodGet, "/api/v1/me", "", "", "", http.StatusOK)
	original := usageDecode[api.User](t, data)

	database, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var externalID string
	if err := database.QueryRow(f.context, `SELECT uniauth_id FROM users WHERE id=$1`, f.userID).Scan(&externalID); err != nil || externalID == "" {
		t.Fatal("read the authenticated account's external identity failed")
	}
	issue := func() applicationTokens {
		t.Helper()
		body, err := json.Marshal(map[string]any{"externalUserId": externalID, "profile": map[string]any{"name": "Ignored existing profile"}})
		if err != nil {
			t.Fatal(err)
		}
		response, data := applicationRequest(t, f, plain, "/api/v1/oauth/s2s/token", string(body), "application/json", "S2S "+f.s2sSharedKey)
		return applicationTokenResponse(t, f, response, data)
	}
	issued := issue()
	_, data = usageRequest(t, f, plain, http.MethodGet, "/api/v1/me", "", "", issued.AccessToken, http.StatusOK)
	if actual := usageDecode[api.User](t, data); !reflect.DeepEqual(actual, original) {
		t.Fatal("S2S issuance did not retain the existing account, Personal Team and profile")
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	application := *f
	application.client = &http.Client{Timeout: 5 * time.Second, Transport: tokenTransport{token: issued.AccessToken, next: transport}}
	_, data = usageRequest(t, f, plain, http.MethodPatch, "/api/v1/me", `{"name":"Application API profile"}`, "application/json", issued.AccessToken, http.StatusOK)
	updated := usageDecode[api.User](t, data)
	name := "Application API profile"
	expected := original
	expected.Name = &name
	if !reflect.DeepEqual(updated, expected) {
		t.Fatal("application profile patch changed unrelated identity or Personal Team fields")
	}
	_, data = usageRequest(t, f, browser, http.MethodGet, "/api/v1/me", "", "", "", http.StatusOK)
	if actual := usageDecode[api.User](t, data); !reflect.DeepEqual(actual, expected) {
		t.Fatal("native owner did not read the committed application profile")
	}

	team := requestJSON[api.Team](t, &application, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Application Team", ExpectedUserID: f.userID}, http.StatusCreated)
	targetName := "Application member"
	added := requestJSON[api.AddTeamMemberReceipt](t, &application, http.MethodPost, "/api/v1/teams/"+team.ID+"/members", map[string]any{
		"expectedUserId": f.userID,
		"user":           map[string]any{"externalUserId": "integration:" + uuid.NewString(), "profile": map[string]any{"name": targetName}},
		"role":           "member",
	}, http.StatusOK)
	members := requestJSON[api.TeamMemberList](t, f, http.MethodGet, "/api/v1/teams/"+team.ID+"/members", nil, http.StatusOK)
	member := expectID(t, members.Items, added.Membership.UserID, func(item api.TeamMemberWithProfile) string { return item.UserID })
	if !added.Added || added.ActorRole != "admin" || member.TeamID != team.ID || member.Role != "member" || !reflect.DeepEqual(member.TeamMember, added.Membership) || member.Profile.Name == nil || *member.Profile.Name != targetName {
		t.Fatal("application direct member did not persist its identity, role and profile")
	}
	project := createProject(t, &application, "Application project")
	task := createTask(t, &application, project, "Application task", map[string]any{"description": "Created by the application grant"})
	assertTaskContent(t, requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK), task)

	readGrants := func() []applicationGrant {
		t.Helper()
		_, data := usageRequest(t, f, browser, http.MethodGet, "/api/v1/oauth/grants", "", "", "", http.StatusOK)
		if bytes.Contains(data, []byte(issued.AccessToken)) || bytes.Contains(data, []byte(issued.RefreshToken)) || bytes.Contains(data, []byte("token_hash")) {
			t.Fatal("owner grant list exposed credential material")
		}
		result := usageDecode[struct {
			UserID string             `json:"userId"`
			Grants []applicationGrant `json:"grants"`
		}](t, data)
		if result.UserID != f.userID {
			t.Fatal("application grant list belongs to a different owner")
		}
		return result.Grants
	}
	initialGrant := expectID(t, readGrants(), issued.GrantID, func(item applicationGrant) string { return item.ID })
	if initialGrant.ClientID != issued.ClientID || initialGrant.ClientName != "Societas Bot" || initialGrant.Resource != issued.Resource || initialGrant.Scope != issued.Scope || !initialGrant.ExpiresAt.Equal(issued.GrantExpiresAt) || initialGrant.Status != "active" || initialGrant.RevokedAt != nil {
		t.Fatal("owner did not see the actual application profile and deadline")
	}
	readUsage := func() *time.Time {
		_, data := usageRequest(t, f, browser, http.MethodGet, "/api/v2/oauth/grants", "", "", "", http.StatusOK)
		page := usageDecode[struct {
			Grants []map[string]json.RawMessage `json:"grants"`
		}](t, data)
		return usageTimestamp(t, usageFind(t, page.Grants, issued.GrantID))
	}
	accessEnd := time.Now()
	accessAt := usageWait(t, f, readUsage, nil, initialGrant.CreatedAt, accessEnd)
	refresh := url.Values{"grant_type": {"refresh_token"}, "client_id": {issued.ClientID}, "resource": {issued.Resource}, "refresh_token": {issued.RefreshToken}}
	refreshStart := time.Now()
	response, data := applicationRequest(t, f, plain, "/oauth/token", refresh.Encode(), "application/x-www-form-urlencoded", "")
	refreshEnd := time.Now()
	renewed := applicationTokenResponse(t, f, response, data)
	if renewed.GrantID != issued.GrantID || renewed.UserID != issued.UserID || renewed.AccessToken == issued.AccessToken || renewed.RefreshToken == issued.RefreshToken || !renewed.GrantExpiresAt.After(issued.GrantExpiresAt) || !renewed.AccessExpiresAt.After(issued.AccessExpiresAt) {
		t.Fatal("application refresh did not rotate the same family with rolling deadlines")
	}
	usageWait(t, f, readUsage, &accessAt, refreshStart, refreshEnd)
	refreshedGrant := expectID(t, readGrants(), issued.GrantID, func(item applicationGrant) string { return item.ID })
	if !refreshedGrant.CreatedAt.Equal(initialGrant.CreatedAt) || !refreshedGrant.ExpiresAt.Equal(renewed.GrantExpiresAt) || refreshedGrant.Status != "active" {
		t.Fatal("owner did not read the committed rolling application deadline")
	}
	profile, err := json.Marshal(map[string]any{"name": original.Name})
	if err != nil {
		t.Fatal(err)
	}
	_, data = usageRequest(t, f, plain, http.MethodPatch, "/api/v1/me", string(profile), "application/json", renewed.AccessToken, http.StatusOK)
	if actual := usageDecode[api.User](t, data); !reflect.DeepEqual(actual, original) {
		t.Fatal("refreshed application access did not update the same account")
	}

	revoke := url.Values{"token": {renewed.AccessToken}, "client_id": {renewed.ClientID}}
	_, data = applicationRequest(t, f, plain, "/oauth/revoke", revoke.Encode(), "application/x-www-form-urlencoded", "")
	if len(data) != 0 {
		t.Fatal("public application revoke did not return an empty response")
	}
	revoked := expectID(t, readGrants(), issued.GrantID, func(item applicationGrant) string { return item.ID })
	if revoked.Status != "revoked" || revoked.RevokedAt == nil || !revoked.CreatedAt.Equal(initialGrant.CreatedAt) {
		t.Fatal("owner did not read the public application revocation")
	}
	assertTaskContent(t, requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK), task)
	reconnected := issue()
	if reconnected.GrantID == issued.GrantID || reconnected.AccessToken == renewed.AccessToken || reconnected.RefreshToken == renewed.RefreshToken {
		t.Fatal("explicit reconnection did not issue an independent application family")
	}
	grants := readGrants()
	if current := expectID(t, grants, issued.GrantID, func(item applicationGrant) string { return item.ID }); current.Status != "revoked" {
		t.Fatal("reconnection changed the old family revocation")
	}
	if current := expectID(t, grants, reconnected.GrantID, func(item applicationGrant) string { return item.ID }); current.Status != "active" || current.ClientName != "Societas Bot" {
		t.Fatal("owner did not see the reconnected application family")
	}
	body, err := json.Marshal(map[string]string{"expectedUserId": f.userID})
	if err != nil {
		t.Fatal(err)
	}
	_, data = usageRequest(t, f, browser, http.MethodPost, "/api/v1/oauth/grants/"+reconnected.GrantID+"/revoke", string(body), "application/json", "", http.StatusOK)
	if result := usageDecode[struct {
		Changed bool `json:"changed"`
	}](t, data); !result.Changed {
		t.Fatal("owner did not revoke the explicitly reconnected family")
	}
	if current := expectID(t, readGrants(), reconnected.GrantID, func(item applicationGrant) string { return item.ID }); current.Status != "revoked" || current.RevokedAt == nil {
		t.Fatal("owner revocation was not visible on the same family")
	}
	for _, secret := range []string{f.s2sSharedKey, issued.AccessToken, issued.RefreshToken, renewed.AccessToken, renewed.RefreshToken, reconnected.AccessToken, reconnected.RefreshToken} {
		if strings.Contains(f.process.logs.String(), secret) {
			t.Fatal("application authorization leaked credential material into Server diagnostics")
		}
	}
}
