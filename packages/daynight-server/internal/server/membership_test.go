package server

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func invitationBody(token string) string {
	encoded, _ := json.Marshal(api.InspectProjectInvitationRequest{Token: token})
	return string(encoded)
}

func invitationActorBody(userID string) string {
	encoded, _ := json.Marshal(api.ProjectInvitationMutationRequest{ExpectedUserID: userID})
	return string(encoded)
}

func invitationAcceptBody(token, userID string) string {
	encoded, _ := json.Marshal(api.AcceptProjectInvitationRequest{Token: token, ExpectedUserID: userID})
	return string(encoded)
}

func memberRoleBody(t *testing.T, version int64, role, expectedUserID string) string {
	t.Helper()
	return jsonBody(t, api.SetProjectMemberRoleRequest{Version: version, Role: role, ExpectedUserID: expectedUserID})
}

func memberRemovalBody(t *testing.T, version int64, expectedUserID string) string {
	t.Helper()
	return jsonBody(t, api.RemoveProjectMemberRequest{Version: version, ExpectedUserID: expectedUserID})
}
