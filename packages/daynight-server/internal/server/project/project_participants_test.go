package project

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestProjectParticipantHTTPContractGrantWritesAndIdentity(t *testing.T) {
	h := membershipTestHarness(t)
	_, token := h.invitation(t)
	decodeResponse[api.ProjectInvitationAcceptance](t, h.call("POST", "/api/v1/invitations/accept", invitationAcceptBody(token, h.memberID), h.member), 200)
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE project_grants SET version=9007199254740993 WHERE project_id=$1 AND user_id=$2`, h.project.ID, h.memberID); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/projects/" + h.project.ID + "/members"
	response := h.call("GET", base, "", h.member)
	people := decodeResponse[api.ProjectParticipantList](t, response, 200)
	if len(people.Items) != 2 || response.Header().Get("Daynight-User-ID") != h.memberID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("participant response: %s %#v", response.Body, response.Header())
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || len(envelope) != 2 || envelope["items"] == nil || envelope["actorAccess"] == nil {
		t.Fatalf("roster envelope: %s %v", response.Body, err)
	}
	var raw []map[string]json.RawMessage
	if err := json.Unmarshal(envelope["items"], &raw); err != nil {
		t.Fatal(err)
	}
	for index, participant := range people.Items {
		if len(raw[index]) != 5 || raw[index]["userId"] == nil || raw[index]["profile"] == nil || raw[index]["effectiveRole"] == nil || raw[index]["directGrant"] == nil || participant.DirectGrant == nil {
			t.Fatalf("participant fields: %#v", raw[index])
		}
		var profile map[string]json.RawMessage
		if err := json.Unmarshal(raw[index]["profile"], &profile); err != nil || len(profile) != 3 || profile["name"] == nil || profile["email"] == nil || profile["avatarUrl"] == nil {
			t.Fatalf("required profile object: %#v %v", profile, err)
		}
		if participant.UserID == h.memberID {
			if participant.Profile.Name != nil || participant.Profile.Email != nil || participant.Profile.AvatarURL != nil || participant.EffectiveRole != "member" || participant.DirectGrant.Version != 9007199254740993 || participant.DirectGrant.ProjectID != h.project.ID || participant.DirectGrant.UserID != h.memberID {
				t.Fatalf("nullable canonical profile and direct grant: %#v", participant)
			}
			if string(profile["name"]) != "null" || string(profile["email"]) != "null" || string(profile["avatarUrl"]) != "null" || !strings.Contains(string(raw[index]["directGrant"]), `"version":9007199254740993`) {
				t.Fatalf("nullable/exact wire values: %#v", raw[index])
			}
		}
	}
	path := base + "/" + h.memberID
	grantResponse := h.call("PATCH", path, memberRoleBody(t, 9007199254740993, "member", h.adminID), h.admin)
	grant := decodeResponse[api.ProjectGrant](t, grantResponse, 200)
	var grantFields map[string]json.RawMessage
	if err := json.Unmarshal(grantResponse.Body.Bytes(), &grantFields); err != nil || len(grantFields) != 6 || string(grantFields["version"]) != "9007199254740993" || grant.ProjectID != h.project.ID || grant.UserID != h.memberID || grant.Role != "member" || grant.CreatedAt.Location() != time.UTC || grant.UpdatedAt.Location() != time.UTC {
		t.Fatalf("mutation returns the real grant: %s %v", grantResponse.Body, err)
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		body := memberRemovalBody(t, grant.Version, h.memberID)
		if method == "PATCH" {
			body = memberRoleBody(t, grant.Version, "admin", h.memberID)
		}
		mismatch := h.call(method, path, body, h.admin)
		assertProjectError(t, mismatch, 409, "identity_mismatch")
		if mismatch.Header().Get("Daynight-User-ID") != h.adminID {
			t.Fatal("mismatch lost the actual response principal")
		}
	}
	after := decodeResponse[api.ProjectParticipantList](t, h.call("GET", base, "", h.admin), 200)
	if !reflect.DeepEqual(after.Items, people.Items) {
		t.Fatal("wrong expected actor changed participant grants or profiles")
	}
	for _, body := range []string{`{"version":1,"role":"member"}`, `{"version":1,"role":"member","expectedUserId":null}`, `{"version":1,"role":"member","expectedUserId":42}`, `{"version":1,"role":"member","expectedUserId":"invalid"}`} {
		assertProjectError(t, h.call("PATCH", path, body, h.admin), 400, "invalid_input")
	}
	for _, body := range []string{`{"version":1}`, `{"version":1,"expectedUserId":null}`, `{"version":1,"expectedUserId":42}`, `{"version":1,"expectedUserId":"invalid"}`} {
		assertProjectError(t, h.call("DELETE", path, body, h.admin), 400, "invalid_input")
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, h.memberID); err != nil {
		t.Fatal(err)
	}
	broken := h.call("GET", base, "", h.admin)
	assertProjectError(t, broken, 500, "internal_error")
	if strings.Contains(broken.Body.String(), `"items"`) || strings.Contains(broken.Body.String(), h.memberID) {
		t.Fatal("integrity failure returned a partial or synthetic roster")
	}
	if !strings.Contains(h.Logs.String(), `"error_code":"identity_mismatch"`) {
		t.Fatal("identity mismatch was not classified as its domain failure")
	}
}
