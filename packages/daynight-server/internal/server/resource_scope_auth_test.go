package server

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestPrivateProjectResourceHTTPAuthenticationAndScope(t *testing.T) {
	integration := newIdentityIntegration(t)
	owner, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t)
	ownerUser := integration.login(t, owner, "alice")
	integration.login(t, outsider, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	_, body := identityRequest(t, owner, http.MethodPost, integration.server.URL+"/api/v1/projects",
		jsonBody(t, api.CreateProjectRequest{Name: "Private resource scope", RepoURL: "https://example.test/private", ExpectedUserID: ownerUser.ID}), origin, http.StatusCreated)
	project := identityDecode[api.Project](t, body)
	_, body = identityRequest(t, owner, http.MethodPost, integration.server.URL+taskCollection(project.ID), `{"title":"Private resource"}`, origin, http.StatusCreated)
	task := identityDecode[api.Task](t, body)
	file := taskPath(task) + "/attachments/files/private.html"
	preview := taskPath(task) + "/preview/private.html"

	request, err := http.NewRequestWithContext(t.Context(), http.MethodPut, integration.server.URL+file, strings.NewReader("<p>private content</p>"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", integration.server.URL)
	request.Header.Set("Content-Type", "text/html")
	response, err := owner.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, readErr := io.Copy(io.Discard, response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || response.StatusCode != http.StatusCreated {
		t.Fatalf("seed attachment: status=%d read=%v close=%v", response.StatusCode, readErr, closeErr)
	}

	base := "/api/v1/projects/" + project.ID
	paths := []string{
		base, base + "/task-graph?taskId=" + task.ID, taskCollection(project.ID), taskPath(task),
		taskPath(task) + "/attachments", file, preview, base + "/members", base + "/invitations",
	}
	for _, path := range paths {
		identityRequest(t, owner, http.MethodGet, integration.server.URL+path, "", nil, http.StatusOK)
		for _, test := range []struct {
			name   string
			client *http.Client
			status int
			code   string
		}{
			{"nonmember", outsider, http.StatusNotFound, "not_found"},
			{"anonymous", anonymous, http.StatusUnauthorized, "unauthenticated"},
		} {
			t.Run(test.name+"/"+path, func(t *testing.T) {
				response, body := identityRequest(t, test.client, http.MethodGet, integration.server.URL+path, "", nil, test.status)
				mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
				if err != nil || mediaType != "application/json" {
					t.Fatalf("denial content type: %q, %v", response.Header.Get("Content-Type"), err)
				}
				var envelope api.ErrorResponse
				if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error.Code != test.code {
					t.Fatalf("denial envelope: %s, %v", body, err)
				}
			})
		}
	}
	_, ownerHead := identityRequest(t, owner, http.MethodHead, integration.server.URL+preview, "", nil, http.StatusOK)
	if len(ownerHead) != 0 {
		t.Fatal("authorized preview HEAD returned a body")
	}
	for _, test := range []struct {
		name   string
		client *http.Client
		status int
	}{
		{"nonmember", outsider, http.StatusNotFound},
		{"anonymous", anonymous, http.StatusUnauthorized},
	} {
		t.Run(test.name+"/preview-head", func(t *testing.T) {
			response, body := identityRequest(t, test.client, http.MethodHead, integration.server.URL+preview, "", nil, test.status)
			mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" || len(body) != 0 {
				t.Fatalf("HEAD denial: type=%q bytes=%d error=%v", response.Header.Get("Content-Type"), len(body), err)
			}
		})
	}
}

func TestPrivateProjectListsRemainIsolatedAcrossPATs(t *testing.T) {
	integration := newIdentityIntegration(t)
	alice, bob := identityBrowser(t), identityBrowser(t)
	aliceUser, bobUser := integration.login(t, alice, "alice"), integration.login(t, bob, "bob")
	if aliceUser.ID == bobUser.ID {
		t.Fatal("fixture identities are not distinct")
	}
	origin := map[string]string{"Origin": integration.server.URL}
	_, data := identityRequest(t, bob, http.MethodPost, integration.server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Bob private project", RepoURL: "https://example.test/bob", ExpectedUserID: bobUser.ID}), origin, http.StatusCreated)
	bobProject := identityDecode[api.Project](t, data)
	mint := func(browser *http.Client, name string) api.CreatedPersonalAccessToken {
		t.Helper()
		_, body := identityRequest(t, browser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", jsonBody(t, map[string]any{"name": name, "expiresAt": nil}), origin, http.StatusCreated)
		created := identityDecode[api.CreatedPersonalAccessToken](t, body)
		if created.ID == "" || !strings.HasPrefix(created.Token, "dnpat_") {
			t.Fatal("PAT creation did not return a usable credential")
		}
		integration.secrets = append(integration.secrets, created.Token)
		return created
	}
	aliceToken, bobToken := mint(alice, "Alice project access"), mint(bob, "Bob project access")
	alicePAT, bobPAT := identityBrowser(t), identityBrowser(t)
	aliceBearer := map[string]string{"Authorization": "Bearer " + aliceToken.Token}
	bobBearer := map[string]string{"Authorization": "Bearer " + bobToken.Token}
	list := func(client *http.Client, bearer map[string]string, userID string) api.ProjectPage {
		t.Helper()
		response, body := identityRequest(t, client, http.MethodGet, integration.server.URL+"/api/v1/projects", "", bearer, http.StatusOK)
		if response.Header.Get("Daynight-User-ID") != userID {
			t.Fatal("PAT project response lost its authenticated identity")
		}
		return identityDecode[api.ProjectPage](t, body)
	}
	bobBefore := list(bobPAT, bobBearer, bobUser.ID)
	if len(bobBefore.Items) != 1 || bobBefore.Items[0] != bobProject || bobBefore.NextCursor != nil {
		t.Fatalf("Bob's initial project scope: %+v", bobBefore)
	}
	_, data = identityRequest(t, alicePAT, http.MethodPost, integration.server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Alice private project", RepoURL: "https://example.test/alice", ExpectedUserID: aliceUser.ID}), aliceBearer, http.StatusCreated)
	aliceProject := identityDecode[api.Project](t, data)
	alicePage := list(alicePAT, aliceBearer, aliceUser.ID)
	if len(alicePage.Items) != 1 || alicePage.Items[0] != aliceProject || alicePage.Items[0].ID == bobProject.ID || alicePage.NextCursor != nil {
		t.Fatalf("Alice's PAT project scope: %+v", alicePage)
	}
	bobAfter := list(bobPAT, bobBearer, bobUser.ID)
	if !reflect.DeepEqual(bobAfter, bobBefore) {
		t.Fatalf("Alice's project creation changed Bob's scope: %+v", bobAfter)
	}
	identityRequest(t, alice, http.MethodDelete, integration.server.URL+"/api/v1/me/tokens/"+aliceToken.ID, "", origin, http.StatusNoContent)
	identityRequest(t, alicePAT, http.MethodGet, integration.server.URL+"/api/v1/projects", "", aliceBearer, http.StatusUnauthorized)
	if afterRevocation := list(bobPAT, bobBearer, bobUser.ID); !reflect.DeepEqual(afterRevocation, bobBefore) {
		t.Fatal("Alice's PAT revocation changed Bob's access")
	}
	if integration.logs.contains(aliceToken.Token) || integration.logs.contains(bobToken.Token) {
		t.Fatal("project request diagnostics exposed a PAT")
	}
}
