package server

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamHTTPProductionCompositionAndLifecycle(t *testing.T) {
	db := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, db, &logs)
	actor := handler.principal.UserID
	body := jsonBody(t, api.CreateTeamRequest{Name: " \t研发😀\u2003 " + strings.Repeat("x", 180), ExpectedUserID: actor})
	response := projectRequest(handler, "POST", "/api/v1/teams", body)
	team := decodeResponse[api.Team](t, response, 201)
	if team.Kind != "ordinary" || team.Name == nil || team.Membership.UserID != actor || team.Membership.TeamID != team.ID || team.Membership.Role != "admin" || team.Membership.Version < 1 || team.Version != 1 {
		t.Fatalf("Team DTO %#v", team)
	}
	if response.Header().Get("Location") != "/api/v1/teams/"+team.ID || response.Header().Get("Daynight-User-ID") != actor || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Team headers %v", response.Header())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 7 {
		t.Fatalf("Team shape %s %v", response.Body, err)
	}
	got := decodeResponse[api.Team](t, projectRequest(handler, "GET", "/api/v1/teams/"+team.ID, ""), 200)
	if !reflect.DeepEqual(got, team) {
		t.Fatal("Team GET differs")
	}
	change := api.ChangeTeamRequest{Name: *team.Name, Version: team.Version, ExpectedUserID: actor}
	same := decodeResponse[api.Team](t, projectRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 200)
	if !reflect.DeepEqual(same, team) {
		t.Fatal("no-op changed Team")
	}
	change.Version = 2
	assertProjectError(t, projectRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 409, "version_conflict")
	change.Version = 1
	change.Name = " Renamed "
	renamed := decodeResponse[api.Team](t, projectRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 200)
	if renamed.Version != 2 || *renamed.Name != change.Name || !reflect.DeepEqual(renamed.Membership, team.Membership) {
		t.Fatalf("renamed %#v", renamed)
	}
	change.Version = renamed.Version
	change.Name = "Renamed"
	assertProjectError(t, projectRequest(handler, "DELETE", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 409, "version_conflict")
	change.Name = *renamed.Name
	deleted := projectRequest(handler, "DELETE", "/api/v1/teams/"+team.ID, jsonBody(t, change))
	receipt := decodeResponse[api.DeleteTeamReceipt](t, deleted, 200)
	if receipt.TeamID != team.ID || !receipt.Deleted {
		t.Fatalf("delete receipt %#v", receipt)
	}
	fields = nil
	if err := json.Unmarshal(deleted.Body.Bytes(), &fields); err != nil || len(fields) != 2 {
		t.Fatalf("delete leaked other resource %s %v", deleted.Body, err)
	}
	assertProjectError(t, projectRequest(handler, "GET", "/api/v1/teams/"+team.ID, ""), 404, "not_found")
	page := decodeResponse[api.TeamPage](t, projectRequest(handler, "GET", "/api/v1/teams?limit=1", ""), 200)
	if page.Items == nil || len(page.Items) != 1 || page.Items[0].Kind != "personal" || page.Items[0].Name != nil || page.NextCursor != nil {
		t.Fatalf("Personal list %#v", page)
	}
	change.Name = "Personal"
	change.Version = page.Items[0].Version
	for _, method := range []string{"PATCH", "DELETE"} {
		assertProjectError(t, projectRequest(handler, method, "/api/v1/teams/"+page.Items[0].ID, jsonBody(t, change)), 409, "personal_team_immutable")
	}
}

func TestTeamHTTPStrictInputAndPagination(t *testing.T) {
	db := projectTestStore(t)
	var logs bytes.Buffer
	h := projectTestHandler(t, db, &logs)
	actor := h.principal.UserID
	suffix := `,"expectedUserId":"` + actor + `"}`
	for _, body := range []string{"", "null", "[]", `{"name":"x"}`, `{"name":null` + suffix, `{"name":1` + suffix, `{"name":""` + suffix, `{"name":" \u2003\u0085"` + suffix, `{"name":"bad\u0000"` + suffix, `{"name":"\ud800"` + suffix, `{"name":"\udfff"` + suffix, `{"name":"\ud800x"` + suffix, `{"name":"x","name":"y"` + suffix, `{"name":"x","extra":1` + suffix, `{"Name":"x"` + suffix, `{"name":"x"` + suffix + ` {}`, `{"name":"` + strings.Repeat("x", maxJSONBody) + `"` + suffix} {
		assertProjectError(t, projectRequest(h, "POST", "/api/v1/teams", body), 400, "invalid_input")
	}
	literal := decodeResponse[api.Team](t, projectRequest(h, "POST", "/api/v1/teams", `{"name":"\\ud800 \ufffd \ud83d\ude00"`+suffix), 201)
	if *literal.Name != "\\ud800 � 😀" {
		t.Fatalf("valid escapes changed %q", *literal.Name)
	}
	for _, name := range []string{"One", "Two"} {
		decodeResponse[api.Team](t, projectRequest(h, "POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: name, ExpectedUserID: actor})), 201)
	}
	page := decodeResponse[api.TeamPage](t, projectRequest(h, "GET", "/api/v1/teams?limit=1", ""), 200)
	if page.NextCursor == nil || page.Items == nil {
		t.Fatalf("first page %#v", page)
	}
	next := decodeResponse[api.TeamPage](t, projectRequest(h, "GET", "/api/v1/teams?limit=1&cursor="+*page.NextCursor, ""), 200)
	if len(next.Items) != 1 || next.Items[0].ID != literal.ID {
		t.Fatalf("next Team page %#v", next)
	}
	for _, path := range []string{"/api/v1/teams?limit=0", "/api/v1/teams?limit=101", "/api/v1/teams?limit=1&limit=2", "/api/v1/teams?cursor=", "/api/v1/teams?cursor=bad", "/api/v1/teams?search=x", "/api/v1/teams/" + literal.ID + "?limit=1", "/api/v1/teams/" + strings.ToUpper(literal.ID), "/api/v1/teams/bad"} {
		assertProjectError(t, projectRequest(h, "GET", path, ""), 400, "invalid_input")
	}
	for _, version := range []string{"0", "-1", "null", `"1"`, "1.1", "1e0", "9223372036854775808"} {
		for _, method := range []string{"PATCH", "DELETE"} {
			assertProjectError(t, projectRequest(h, method, "/api/v1/teams/"+literal.ID, `{"name":"ok","version":`+version+suffix), 400, "invalid_input")
		}
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		assertProjectError(t, projectRequest(h, method, "/api/v1/teams/"+literal.ID, `{"name":"\ud800","version":1`+suffix), 400, "invalid_input")
		assertProjectError(t, projectRequest(h, method, "/api/v1/teams/"+literal.ID+"?unexpected=1", `{"name":"ok","version":1`+suffix), 400, "invalid_input")
	}
	assertProjectError(t, projectRequest(h, "POST", "/api/v1/teams?unexpected=1", `{"name":"ok"`+suffix), 400, "invalid_input")
	for _, method := range []string{"PUT", "DELETE", "PATCH"} {
		r := projectRequest(h, method, "/api/v1/teams", `{}`)
		assertProjectError(t, r, 405, "method_not_allowed")
		if r.Header().Get("Allow") != "GET, HEAD, POST" {
			t.Fatal(r.Header())
		}
	}
	r := projectRequest(h, "POST", "/api/v1/teams/"+literal.ID, `{}`)
	assertProjectError(t, r, 405, "method_not_allowed")
	if r.Header().Get("Allow") != "GET, HEAD, PATCH, DELETE" {
		t.Fatal(r.Header())
	}
	precise := int64(9007199254740993)
	if _, err := db.Pool.Exec(context.Background(), `UPDATE teams SET version=$2 WHERE id=$1`, literal.ID, precise); err != nil {
		t.Fatal(err)
	}
	exact := projectRequest(h, "PATCH", "/api/v1/teams/"+literal.ID, jsonBody(t, api.ChangeTeamRequest{Name: *literal.Name, Version: precise, ExpectedUserID: actor}))
	if decodeResponse[api.Team](t, exact, 200).Version != precise || !strings.Contains(exact.Body.String(), `"version":9007199254740993`) {
		t.Fatal("int64 version rounded", exact.Body)
	}
}

func TestTeamHTTPSessionPATAndIdentityPermissions(t *testing.T) {
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	teamRoutes(mux, service.NewTeams(h.database), h.auth, logger)
	h.handler = RequestLogging(logger, mux)
	admin, member, outsider := h.login(t, "team-admin"), h.login(t, "team-member"), h.login(t, "team-outsider")
	cookies := []*http.Cookie{admin}
	user := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", cookies, nil, ""), 200)
	memberUser := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", []*http.Cookie{member}, nil, ""), 200)
	body := jsonBody(t, api.CreateTeamRequest{Name: "Protected", ExpectedUserID: user.ID})
	assertProjectError(t, h.request("POST", "/api/v1/teams", body, nil, nil, ""), 401, "unauthenticated")
	assertProjectError(t, h.request("POST", "/api/v1/teams", body, cookies, nil, "https://foreign.test"), 403, "forbidden")
	team := decodeResponse[api.Team](t, h.request("POST", "/api/v1/teams", body, cookies, nil, h.auth.origin), 201)
	if _, err := h.database.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, memberUser.ID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		cookie   *http.Cookie
		expected string
		status   int
	}{{member, "forbidden", 403}, {outsider, "not_found", 404}} {
		actor := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", []*http.Cookie{test.cookie}, nil, ""), 200)
		for _, method := range []string{"PATCH", "DELETE"} {
			assertProjectError(t, h.request(method, "/api/v1/teams/"+team.ID, jsonBody(t, api.ChangeTeamRequest{Name: "Protected", Version: 1, ExpectedUserID: actor.ID}), []*http.Cookie{test.cookie}, nil, h.auth.origin), test.status, test.expected)
		}
	}
	for _, method := range []string{"POST", "PATCH", "DELETE"} {
		path := "/api/v1/teams/" + team.ID
		input := any(api.ChangeTeamRequest{Name: "Changed", Version: 1, ExpectedUserID: memberUser.ID})
		if method == "POST" {
			path = "/api/v1/teams"
			input = api.CreateTeamRequest{Name: "Changed", ExpectedUserID: memberUser.ID}
		}
		assertProjectError(t, h.request(method, path, jsonBody(t, input), cookies, nil, h.auth.origin), 409, "identity_mismatch")
	}
	got := decodeResponse[api.Team](t, h.request("GET", "/api/v1/teams/"+team.ID, "", cookies, nil, ""), 200)
	if !reflect.DeepEqual(got, team) {
		t.Fatal("identity mismatch changed Team")
	}
	token := decodeResponse[api.CreatedPersonalAccessToken](t, h.request("POST", "/api/v1/me/tokens", `{"name":"Team API","expiresAt":null}`, cookies, nil, h.auth.origin), 201)
	pat := decodeResponse[api.Team](t, h.request("POST", "/api/v1/teams", body, nil, []string{"Bearer " + token.Token}, "https://foreign.test"), 201)
	if pat.Membership.UserID != user.ID {
		t.Fatal("PAT principal changed")
	}
	memberGet := h.request("GET", "/api/v1/teams/"+team.ID, "", []*http.Cookie{member}, nil, "")
	if decodeResponse[api.Team](t, memberGet, 200).Membership.UserID != memberUser.ID || memberGet.Header().Get("Daynight-User-ID") != memberUser.ID {
		t.Fatal("membership/identity envelope")
	}
	assertProjectError(t, h.request("GET", "/api/v1/teams/"+team.ID, "", []*http.Cookie{outsider}, nil, ""), 404, "not_found")
}

func TestTeamHTTPOutcomeClassificationAndResponseFailures(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest("PATCH", "/api/v1/teams/"+uuid.NewString(), nil)
	request.Header.Set("X-Request-ID", "project-test")
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}, 503, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: &pgconn.PgError{Code: "08006", Message: "private database failure"}}, 503, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: &model.Fault{Code: "forbidden", Message: "private refusal"}}, 500, "internal_error"},
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionNotCommitted, Cause: errors.New("private rolled back")}, 500, "internal_error"},
		{&model.Fault{Code: "team_not_empty", Message: "Transfer projects first"}, 409, "team_not_empty"},
	} {
		w := httptest.NewRecorder()
		RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeTeamError(w, r, logger, "rename", test.err) })).ServeHTTP(w, request)
		assertProjectError(t, w, test.status, test.code)
	}
	for _, short := range []bool{false, true} {
		w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
		writeTeamJSON(w, request, logger, 201, api.DeleteTeamReceipt{TeamID: uuid.NewString(), Deleted: true})
		if w.calls != 1 {
			t.Fatal("response automatically replayed")
		}
	}
	marshal := httptest.NewRecorder()
	writeTeamJSON(marshal, request, logger, 201, func() {})
	if marshal.Code != 503 || !strings.Contains(marshal.Body.String(), `"code":"write_outcome_unknown"`) {
		t.Fatal("encoding failure hid committed outcome", marshal.Body)
	}
	canceled, cancel := context.WithCancel(request.Context())
	cancel()
	w := httptest.NewRecorder()
	writeTeamJSON(w, request.WithContext(canceled), logger, 201, struct{}{})
	if w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" {
		t.Fatal("canceled response wrote body")
	}
	if strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), `"team_error_code":"write_outcome_unknown"`) {
		t.Fatalf("unsafe or unclassified errors %s", &logs)
	}
}

func TestTeamHTTPReservedIdentityCallbackPaths(t *testing.T) {
	for _, path := range []string{"/api/v1/teams", "/api/v1/teams/" + uuid.NewString(), "/teams", "/teams/" + uuid.NewString()} {
		_, _, err := validateAuthSettings(AuthConfig{PublicOrigin: "https://example.com"}, "https://example.com"+path)
		if err == nil {
			t.Fatalf("identity callback captured Team path %s", path)
		}
	}
}
