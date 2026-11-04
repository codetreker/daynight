package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
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
		err := h.database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
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
	lock, err := h.database.Pool.Begin(context.Background())
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

func TestProjectGrantErrorTransactionOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"unknown commit", &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}, 503, "write_outcome_unknown"},
		{"unknown cleanup", &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: &service.Fault{Code: "version_conflict", Message: "private"}}, 503, "write_outcome_unknown"},
		{"confirmed rollback", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &service.Fault{Code: "version_conflict", Message: "version conflict"}}, 409, "version_conflict"},
		{"known rollback with cleanup failure", &store.TransactionError{Phase: "cleanup", CommitAttempted: true, CleanupFailed: true, Outcome: store.TransactionNotCommitted, Cause: &service.Fault{Code: "version_conflict", Message: "private"}}, 500, "internal_error"},
		{"database failure", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("private")}, 500, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			w := httptest.NewRecorder()
			r := httptest.NewRequest("PUT", "/", nil)
			r.Header.Set("X-Request-ID", "project-test")
			RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeGrantError(w, r, logger, "set", time.Now(), tc.err)
			})).ServeHTTP(w, r)
			assertProjectError(t, w, tc.status, tc.code)
			if strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), `"component":"project_grant"`) {
				t.Fatalf("unsafe or unscoped log: %s", logs.String())
			}
		})
	}
}

func TestProjectGrantVersionDecoderExact(t *testing.T) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`{"version":9007199254740993}`), &fields); err != nil {
		t.Fatal(err)
	}
	v, err := grantVersion(fields)
	if err != nil || v == nil || *v != 9007199254740993 {
		t.Fatalf("exact version: %v %v", v, err)
	}
}

func TestProjectGrantHTTPSelfRemovalReportsLostAccess(t *testing.T) {
	h := membershipTestHarness(t)
	base := "/api/v1/projects/" + h.project.ID
	_, token := h.invitation(t)
	member := decodeResponse[api.ProjectMember](t, h.call("POST", "/api/v1/invitations/accept", invitationBody(token), h.member), 200)
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

func TestProjectGrantResponseWriteFailureIsNotRetried(t *testing.T) {
	for _, short := range []bool{false, true} {
		var logs bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
		request := httptest.NewRequest(http.MethodPut, "/", nil)
		writeGrantJSON(writer, request, logger, time.Now(), api.RemoveProjectGrantResult{Deleted: true})
		if writer.calls != 1 || writer.Code != 200 || strings.Contains(logs.String(), "private response failure") || !strings.Contains(logs.String(), `"phase":"response"`) || !strings.Contains(logs.String(), `"outcome":"unknown"`) || strings.Count(logs.String(), `"msg":"operation failed"`) != 1 {
			t.Fatalf("response failure: calls=%d status=%d log=%s", writer.calls, writer.Code, logs.String())
		}
	}
}

// A database timestamp outside JSON's year range makes a committed receipt
// impossible to encode; this is an unknown client outcome rather than success.
func TestProjectGrantResponseEncodingFailure(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPut, "/", nil)
	r.Header.Set("X-Request-ID", "project-test")
	RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := api.ProjectGrantResult{Grant: api.ProjectGrant{CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}}
		writeGrantJSON(w, r, logger, time.Now(), result)
	})).ServeHTTP(w, r)
	assertProjectError(t, w, http.StatusServiceUnavailable, "write_outcome_unknown")
	if !strings.Contains(logs.String(), `"outcome":"unknown"`) || !strings.Contains(logs.String(), `"phase":"response"`) {
		t.Fatalf("missing response classification: %s", logs.String())
	}
}

func TestProjectGrantCanceledResponseDoesNotWrite(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodDelete, "/", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	writeGrantJSON(w, r, logger, time.Now(), api.RemoveProjectGrantResult{Deleted: true})
	if w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"outcome":"unknown"`) {
		t.Fatalf("canceled response wrote data or lost classification: %s", logs.String())
	}
}
