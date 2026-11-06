package server

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestStepsHTTPEditPreservesReferencedAttachment(t *testing.T) {
	_, handler, task := stepsHTTPFixture(t, io.Discard)
	path := taskPath(task) + "/steps"
	file := attachmentFilePath(task, "plans/evidence.bin")
	content := []byte{0, 0xff, 0x80, '\n', 'x'}
	metadata := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, file, "application/octet-stream", content), http.StatusCreated)
	added := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{
		"version": task.Version, "id": "abcdef01", "title": "Evidence", "description": "[Evidence](plans/evidence.bin)",
	})), http.StatusCreated)
	if len(added.Steps) != 1 {
		t.Fatalf("initial step: %+v", added)
	}
	original := added.Steps[0]
	changed := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodPatch, path+"/abcdef01", jsonBody(t, map[string]any{
		"version": added.Version, "title": "Updated evidence", "description": "",
	})), http.StatusOK)
	if changed.Version != added.Version+1 || len(changed.Steps) != 1 || changed.Steps[0].ID != original.ID || changed.Steps[0].Title != "Updated evidence" || changed.Steps[0].Description != "" || changed.Steps[0].Status != original.Status || changed.Steps[0].CreatedAt != original.CreatedAt {
		t.Fatalf("edited step: %+v", changed)
	}
	response := attachmentRequest(handler, http.MethodGet, file, "", nil)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), content) {
		t.Fatalf("editing changed attachment bytes: %d %x", response.Code, response.Body.Bytes())
	}
	page := decodeResponse[api.AttachmentPage](t, projectRequest(handler, http.MethodGet, taskPath(task)+"/attachments", ""), http.StatusOK)
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], metadata) {
		t.Fatalf("editing changed attachment metadata: %+v", page)
	}
}

func TestStepsHTTPRevokedMemberCannotRead(t *testing.T) {
	integration := newIdentityIntegration(t)
	admin, member := identityBrowser(t), identityBrowser(t)
	adminUser := integration.login(t, admin, "alice")
	memberUser := integration.login(t, member, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	_, data := identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Revoked Step reader", RepoURL: "https://example.com/steps-revoked", ExpectedUserID: adminUser.ID}), origin, http.StatusCreated)
	project := identityDecode[api.Project](t, data)
	base := "/api/v1/projects/" + project.ID
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+base+"/invitations", invitationActorBody(adminUser.ID), origin, http.StatusCreated)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("invitation omitted its token")
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationAcceptBody(link.Fragment, memberUser.ID), origin, http.StatusOK)
	joined := identityDecode[api.ProjectInvitationAcceptance](t, data)
	if joined.DirectGrant.UserID != memberUser.ID || joined.Access.TeamRole != nil {
		t.Fatalf("fixture did not create direct-only membership: %+v", joined)
	}
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+base+"/tasks", `{"title":"Private Step"}`, origin, http.StatusCreated)
	task := identityDecode[api.Task](t, data)
	path := base + "/tasks/" + task.ID + "/steps"
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+path, `{"version":1,"id":"abcdef01","title":"Secret Step"}`, origin, http.StatusCreated)
	created := identityDecode[api.StepsResource](t, data)
	_, data = identityRequest(t, member, http.MethodGet, integration.server.URL+path, "", nil, http.StatusOK)
	if before := identityDecode[api.StepsResource](t, data); !reflect.DeepEqual(before, created) {
		t.Fatal("member could not read the granted Step")
	}
	identityRequest(t, admin, http.MethodDelete, integration.server.URL+base+"/members/"+memberUser.ID, memberRemovalBody(t, joined.DirectGrant.Version, adminUser.ID), origin, http.StatusNoContent)
	for _, suffix := range []string{"", "/abcdef01"} {
		_, data := identityRequest(t, member, http.MethodGet, integration.server.URL+path+suffix, "", nil, http.StatusNotFound)
		if failure := identityDecode[api.ErrorResponse](t, data); failure.Error.Code != "not_found" {
			t.Fatalf("revoked member read: %+v", failure)
		}
	}
	_, data = identityRequest(t, admin, http.MethodGet, integration.server.URL+path, "", nil, http.StatusOK)
	if after := identityDecode[api.StepsResource](t, data); !reflect.DeepEqual(after, created) {
		t.Fatal("member removal changed the owner's Steps")
	}
}
