package server

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
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
