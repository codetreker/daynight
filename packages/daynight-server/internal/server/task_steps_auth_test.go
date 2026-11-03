package server

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestStepsHTTPAuthenticatedMemberAndHEAD(t *testing.T) {
	integration := newIdentityIntegration(t)
	admin, member, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t), identityBrowser(t)
	integration.login(t, admin, "alice")
	memberUser := integration.login(t, member, "bob")
	integration.login(t, outsider, "nullable")
	origin := map[string]string{"Origin": integration.server.URL}
	_, data := identityRequest(t, admin, "POST", integration.server.URL+"/api/v1/projects", `{"name":"Steps auth","repoUrl":"https://example.com/steps"}`, origin, 201)
	project := identityDecode[api.Project](t, data)
	base := "/api/v1/projects/" + project.ID
	_, data = identityRequest(t, admin, "POST", integration.server.URL+base+"/invitations", `{}`, origin, 201)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil {
		t.Fatal(err)
	}
	identityRequest(t, member, "POST", integration.server.URL+"/api/v1/invitations/accept", invitationBody(link.Fragment), origin, 200)
	_, data = identityRequest(t, admin, "POST", integration.server.URL+base+"/tasks", `{"title":"Steps without Session"}`, origin, 201)
	task := identityDecode[api.Task](t, data)
	path := base + "/tasks/" + task.ID + "/steps"
	for _, browser := range []*http.Client{admin, member} {
		response, data := identityRequest(t, browser, "GET", integration.server.URL+path, "", nil, 200)
		resource := identityDecode[api.StepsResource](t, data)
		if response.Header.Get("Cache-Control") != "no-store" || resource.Steps == nil || len(resource.Steps) != 0 {
			t.Fatal("admin/member read failed")
		}
	}
	for _, suffix := range []string{"", "/00000000"} {
		for _, method := range []string{"GET", "HEAD", "POST"} {
			response, data := identityRequest(t, anonymous, method, integration.server.URL+path+suffix, "", nil, 401)
			if response.Header.Get("Cache-Control") != "no-store" || method == "HEAD" && len(data) != 0 {
				t.Fatal("anonymous response metadata/body invalid")
			}
		}
		_, data := identityRequest(t, outsider, "GET", integration.server.URL+path+suffix, "", nil, 404)
		if identityDecode[api.ErrorResponse](t, data).Error.Code != "not_found" {
			t.Fatal("nonmember resource leaked")
		}
	}
	response, data := identityRequest(t, member, "HEAD", integration.server.URL+path, "", nil, 200)
	if len(data) != 0 || response.Header.Get("Content-Type") != "application/json" || response.Header.Get("Daynight-User-ID") != memberUser.ID {
		t.Fatal("HEAD lost identity/type or returned body")
	}
	body := `{"version":1,"id":"00000000","title":"Member add"}`
	identityRequest(t, member, "POST", integration.server.URL+path, body, nil, 403)
	identityRequest(t, member, "POST", integration.server.URL+path, body, map[string]string{"Origin": "https://unrelated.invalid"}, 403)
	_, data = identityRequest(t, outsider, "POST", integration.server.URL+path, body, origin, 404)
	if identityDecode[api.ErrorResponse](t, data).Error.Code != "not_found" {
		t.Fatal("nonmember write leaked task")
	}
	response, data = identityRequest(t, member, "POST", integration.server.URL+path, body, origin, 201)
	added := identityDecode[api.StepsResource](t, data)
	if added.Version != 2 || len(added.Steps) != 1 || response.Header.Get("Location") != path+"/00000000" {
		t.Fatal("member could not add")
	}
	_, data = identityRequest(t, admin, "POST", integration.server.URL+path, `{"version":2,"id":"abcdef01","title":"Admin add"}`, origin, 201)
	if identityDecode[api.StepsResource](t, data).Version != 3 {
		t.Fatal("admin could not add")
	}
	for _, change := range []struct{ method, suffix, body string }{{"PATCH", "/00000000", `{"version":3,"description":"edited"}`}, {"PUT", "/00000000/status", `{"version":4,"status":"in_progress"}`}} {
		identityRequest(t, anonymous, change.method, integration.server.URL+path+change.suffix, change.body, nil, 401)
		identityRequest(t, member, change.method, integration.server.URL+path+change.suffix, change.body, nil, 403)
		identityRequest(t, member, change.method, integration.server.URL+path+change.suffix, change.body, map[string]string{"Origin": "https://unrelated.invalid"}, 403)
		_, data = identityRequest(t, outsider, change.method, integration.server.URL+path+change.suffix, change.body, origin, 404)
		if identityDecode[api.ErrorResponse](t, data).Error.Code != "not_found" {
			t.Fatal("nonmember change leaked task")
		}
		_, data = identityRequest(t, member, change.method, integration.server.URL+path+change.suffix, change.body, origin, 200)
		if len(identityDecode[api.StepsResource](t, data).Steps) != 2 {
			t.Fatal("member change lost collection")
		}
	}
	_, data = identityRequest(t, member, "POST", integration.server.URL+"/api/v1/me/tokens", `{"name":"Steps PAT","expiresAt":null}`, origin, 201)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	identityRequest(t, anonymous, "GET", integration.server.URL+path, "", map[string]string{"Authorization": "Bearer " + token.Token}, 200)
}
