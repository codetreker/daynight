package project

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestProjectGrantHTTPReceiptsAndIdentity(t *testing.T) {
	h := membershipTestHarness(t)
	base := "/api/v1/projects/" + h.project.ID
	path := base + "/grants/" + h.adminID
	members := decodeResponse[api.ProjectParticipantList](t, h.call("GET", base+"/members", "", h.admin), 200)
	var version int64
	for _, item := range members.Items {
		if item.UserID == h.adminID {
			version = item.DirectGrant.Version
		}
	}
	if version < 1 {
		t.Fatal("missing admin grant")
	}
	snapshot := func() string {
		t.Helper()
		var state string
		err := h.Database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
			'project', (SELECT to_jsonb(p) FROM projects p WHERE p.id=$1),
			'ownership', (SELECT to_jsonb(o) FROM project_ownership o WHERE o.project_id=$1),
			'grants', (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id) FROM project_grants g WHERE g.project_id=$1),
			'teamMembers', (SELECT jsonb_agg(to_jsonb(tm) ORDER BY tm.user_id) FROM team_members tm JOIN project_ownership o ON o.team_id=tm.team_id WHERE o.project_id=$1)
		)::text`, h.project.ID).Scan(&state)
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	lock, err := h.Database.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	if _, err := lock.Exec(context.Background(), `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, h.project.ID); err != nil {
		t.Fatal(err)
	}
	wrong := fmt.Sprintf(`{"version":%d,"expectedUserId":%q}`, version, h.memberID)
	wrongPut := fmt.Sprintf(`{"version":%d,"role":"member","expectedUserId":%q}`, version, h.memberID)
	for _, call := range []struct{ method, body string }{{"DELETE", wrong}, {"PUT", wrongPut}} {
		responses := make(chan *httptest.ResponseRecorder, 1)
		go func() { responses <- h.call(call.method, path, call.body, h.admin) }()
		select {
		case response := <-responses:
			assertProjectError(t, response, 409, "identity_mismatch")
		case <-time.After(3 * time.Second):
			t.Fatalf("%s identity guard waited for the project domain lock", call.method)
		}
	}
	if err := lock.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(); after != before {
		t.Fatalf("identity mismatch changed domain rows: %s -> %s", before, after)
	}
	remove := fmt.Sprintf(`{"version":%d,"expectedUserId":%q}`, version, h.adminID)
	response := h.call("DELETE", path, remove, h.admin)
	removed := decodeResponse[api.RemoveProjectGrantResult](t, response, 200)
	if !removed.Deleted || removed.ProjectID != h.project.ID || removed.UserID != h.adminID || removed.ActorAccess == nil || removed.ActorAccess.EffectiveRole != "admin" || removed.ActorAccess.DirectGrant != nil || response.Header().Get("Daynight-User-ID") != h.adminID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("remove: %+v %s", removed, response.Body)
	}
	assertProjectError(t, h.call("DELETE", path, remove, h.admin), 409, "version_conflict")
	put := fmt.Sprintf(`{"version":null,"role":"member","expectedUserId":%q}`, h.adminID)
	response = h.call("PUT", path, put, h.admin)
	created := decodeResponse[api.ProjectGrantResult](t, response, 200)
	if created.Grant.Version <= version || created.Grant.Role != "member" || created.ActorAccess == nil || created.ActorAccess.EffectiveRole != "admin" || created.ActorAccess.DirectGrant == nil || created.ActorAccess.DirectGrant.Version != created.Grant.Version {
		t.Fatalf("create: %+v %s", created, response.Body)
	}
	assertProjectError(t, h.call("PUT", path, put, h.admin), 409, "version_conflict")
	assertProjectError(t, h.call("DELETE", path, remove, h.admin), 409, "version_conflict")
	outsider := decodeResponse[api.User](t, h.call("GET", "/api/v1/me", "", h.outsider), 200)
	assertProjectError(t, h.call("PUT", base+"/grants/"+outsider.ID, put, h.admin), 404, "not_found")
	method := h.call("POST", path, "{}", h.admin)
	if method.Code != 405 || method.Header().Get("Allow") != "PUT, DELETE" {
		t.Fatalf("method: %d %s", method.Code, method.Body)
	}
}

func TestProjectGrantHTTPStrictVersion(t *testing.T) {
	h := membershipTestHarness(t)
	path := "/api/v1/projects/" + h.project.ID + "/grants/" + h.adminID
	for _, value := range []string{``, `,"version":0`, `,"version":-1`, `,"version":1.0`, `,"version":9223372036854775808`, `,"version":"1"`, `,"version":true`} {
		body := fmt.Sprintf(`{"role":"member","expectedUserId":%q%s}`, h.adminID, value)
		assertProjectError(t, h.call("PUT", path, body, h.admin), 400, "invalid_input")
	}
	for _, value := range []string{`null`, `0`, `1.0`, `9223372036854775808`} {
		body := fmt.Sprintf(`{"version":%s,"expectedUserId":%q}`, value, h.adminID)
		assertProjectError(t, h.call("DELETE", path, body, h.admin), 400, "invalid_input")
	}
}

func TestProjectGrantHTTPSelfRemovalReportsLostAccess(t *testing.T) {
	h := membershipTestHarness(t)
	base := "/api/v1/projects/" + h.project.ID
	_, token := h.invitation(t)
	member := decodeResponse[api.ProjectInvitationAcceptance](t, h.call("POST", "/api/v1/invitations/accept", invitationAcceptBody(token, h.memberID), h.member), 200).DirectGrant
	path := base + "/grants/" + h.memberID
	promote := fmt.Sprintf(`{"version":%d,"role":"admin","expectedUserId":%q}`, member.Version, h.adminID)
	grant := decodeResponse[api.ProjectGrantResult](t, h.call("PUT", path, promote, h.admin), 200)
	remove := fmt.Sprintf(`{"version":%d,"expectedUserId":%q}`, grant.Grant.Version, h.memberID)
	response := h.call("DELETE", path, remove, h.member)
	result := decodeResponse[api.RemoveProjectGrantResult](t, response, 200)
	if !result.Deleted || result.ActorAccess != nil || result.UserID != h.memberID || !strings.Contains(response.Body.String(), `"actorAccess":null`) || response.Header().Get("Daynight-User-ID") != h.memberID {
		t.Fatalf("self removal receipt: %+v %s", result, response.Body)
	}
	assertProjectError(t, h.call("GET", base+"/members", "", h.member), 404, "not_found")
}

func TestProjectGrantHTTPDemotedMemberCannotPromoteSelf(t *testing.T) {
	h := membershipTestHarness(t)
	base := "/api/v1/projects/" + h.project.ID
	_, token := h.invitation(t)
	joined := decodeResponse[api.ProjectInvitationAcceptance](t, h.call("POST", "/api/v1/invitations/accept", invitationAcceptBody(token, h.memberID), h.member), 200).DirectGrant
	path := base + "/grants/" + h.memberID
	promote := fmt.Sprintf(`{"version":%d,"role":"admin","expectedUserId":%q}`, joined.Version, h.adminID)
	promoted := decodeResponse[api.ProjectGrantResult](t, h.call("PUT", path, promote, h.admin), 200)
	demote := fmt.Sprintf(`{"version":%d,"role":"member","expectedUserId":%q}`, promoted.Grant.Version, h.adminID)
	demoted := decodeResponse[api.ProjectGrantResult](t, h.call("PUT", path, demote, h.admin), 200)
	if demoted.Grant.Role != "member" || demoted.Grant.Version <= promoted.Grant.Version {
		t.Fatalf("demotion did not persist the current grant: %+v", demoted.Grant)
	}
	attempt := fmt.Sprintf(`{"version":%d,"role":"admin","expectedUserId":%q}`, demoted.Grant.Version, h.memberID)
	assertProjectError(t, h.call("PUT", path, attempt, h.member), 403, "forbidden")
	people := decodeResponse[api.ProjectParticipantList](t, h.call("GET", base+"/members", "", h.admin), 200)
	for _, person := range people.Items {
		if person.UserID == h.memberID {
			if person.DirectGrant == nil || *person.DirectGrant != demoted.Grant || person.EffectiveRole != "member" {
				t.Fatalf("refused self-promotion changed the grant: %+v", person)
			}
			return
		}
	}
	t.Fatal("demoted member disappeared from the participant list")
}
