package team

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamHTTPSessionPATAndIdentityPermissions(t *testing.T) {
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	RegisterRoutes(mux, teamservice.NewTeams(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	admin, member, outsider := h.Login(t, "team-admin"), h.Login(t, "team-member"), h.Login(t, "team-outsider")
	cookies := []*http.Cookie{admin}
	user := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 200)
	memberUser := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{member}, nil, ""), 200)
	body := jsonBody(t, api.CreateTeamRequest{Name: "Protected", ExpectedUserID: user.ID})
	assertProjectError(t, h.Request("POST", "/api/v1/teams", body, nil, nil, ""), 401, "unauthenticated")
	assertProjectError(t, h.Request("POST", "/api/v1/teams", body, cookies, nil, "https://foreign.test"), 403, "forbidden")
	team := decodeResponse[api.Team](t, h.Request("POST", "/api/v1/teams", body, cookies, nil, h.Origin), 201)
	if _, err := h.Database.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, memberUser.ID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		cookie   *http.Cookie
		expected string
		status   int
	}{{member, "forbidden", 403}, {outsider, "not_found", 404}} {
		actor := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{test.cookie}, nil, ""), 200)
		for _, method := range []string{"PATCH", "DELETE"} {
			assertProjectError(t, h.Request(method, "/api/v1/teams/"+team.ID, jsonBody(t, api.ChangeTeamRequest{Name: "Protected", Version: 1, ExpectedUserID: actor.ID}), []*http.Cookie{test.cookie}, nil, h.Origin), test.status, test.expected)
		}
	}
	for _, method := range []string{"POST", "PATCH", "DELETE"} {
		path := "/api/v1/teams/" + team.ID
		input := any(api.ChangeTeamRequest{Name: "Changed", Version: 1, ExpectedUserID: memberUser.ID})
		if method == "POST" {
			path = "/api/v1/teams"
			input = api.CreateTeamRequest{Name: "Changed", ExpectedUserID: memberUser.ID}
		}
		assertProjectError(t, h.Request(method, path, jsonBody(t, input), cookies, nil, h.Origin), 409, "identity_mismatch")
	}
	got := decodeResponse[api.Team](t, h.Request("GET", "/api/v1/teams/"+team.ID, "", cookies, nil, ""), 200)
	if !reflect.DeepEqual(got, team) {
		t.Fatal("identity mismatch changed Team")
	}
	token := decodeResponse[api.CreatedPersonalAccessToken](t, h.Request("POST", "/api/v1/me/tokens", `{"name":"Team API","expiresAt":null}`, cookies, nil, h.Origin), 201)
	pat := decodeResponse[api.Team](t, h.Request("POST", "/api/v1/teams", body, nil, []string{"Bearer " + token.Token}, "https://foreign.test"), 201)
	if pat.Membership.UserID != user.ID {
		t.Fatal("PAT principal changed")
	}
	memberGet := h.Request("GET", "/api/v1/teams/"+team.ID, "", []*http.Cookie{member}, nil, "")
	if decodeResponse[api.Team](t, memberGet, 200).Membership.UserID != memberUser.ID || memberGet.Header().Get("Daynight-User-ID") != memberUser.ID {
		t.Fatal("membership/identity envelope")
	}
	assertProjectError(t, h.Request("GET", "/api/v1/teams/"+team.ID, "", []*http.Cookie{outsider}, nil, ""), 404, "not_found")
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
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeTeamError(w, r, logger, "rename", test.err) })).ServeHTTP(w, request)
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

func TestTeamHTTPStrictInputAndPagination(t *testing.T) {
	h := teamTestHandler(t)
	db := h.database
	actor := h.principal.UserID
	suffix := `,"expectedUserId":"` + actor + `"}`
	for _, body := range []string{"", "null", "[]", `{"name":"x"}`, `{"name":null` + suffix, `{"name":1` + suffix, `{"name":""` + suffix, `{"name":" \u2003\u0085"` + suffix, `{"name":"bad\u0000"` + suffix, `{"name":"\ud800"` + suffix, `{"name":"\udfff"` + suffix, `{"name":"\ud800x"` + suffix, `{"name":"x","name":"y"` + suffix, `{"name":"x","extra":1` + suffix, `{"Name":"x"` + suffix, `{"name":"x"` + suffix + ` {}`} {
		assertProjectError(t, projectRequest(h, "POST", "/api/v1/teams", body), 400, "invalid_input")
	}
	assertProjectError(t, projectRequest(h, "POST", "/api/v1/teams", `{"name":"`+strings.Repeat("x", httpx.MaxJSONBody)+`"`+suffix), 413, "payload_too_large")
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

func TestTeamHTTPPageCountAndCursor(t *testing.T) {
	h := teamTestHandler(t)
	actor := h.principal.UserID
	var teams []api.Team
	for _, suffix := range []string{"one", "two"} {
		name := strings.Repeat("<", 250) + suffix
		team := decodeResponse[api.Team](t, projectRequest(h, "POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: name, ExpectedUserID: actor})), 201)
		teams = append(teams, team)
	}
	complete := decodeResponse[api.TeamPage](t, projectRequest(h, "GET", "/api/v1/teams?limit=100", ""), 200)
	if len(complete.Items) != 3 || !reflect.DeepEqual(complete.Items[1:], teams) || complete.NextCursor != nil {
		t.Fatalf("complete page: %+v", complete)
	}
	first := decodeResponse[api.TeamPage](t, projectRequest(h, "GET", "/api/v1/teams?limit=2", ""), 200)
	if len(first.Items) != 2 || !reflect.DeepEqual(first.Items[1], teams[0]) || first.NextCursor == nil {
		t.Fatalf("first page: %+v", first)
	}
	next := decodeResponse[api.TeamPage](t, projectRequest(h, "GET", "/api/v1/teams?limit=2&cursor="+*first.NextCursor, ""), 200)
	if len(next.Items) != 1 || !reflect.DeepEqual(next.Items[0], teams[1]) || next.NextCursor != nil {
		t.Fatalf("continuation: %+v", next)
	}
}

func TestTeamHTTPProductionCompositionAndLifecycle(t *testing.T) {
	db := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := teamComponentHost(t, db, &logs)
	actor := handler.principal.UserID
	rawName := " \t研发😀\u2003 " + strings.Repeat("x", 180)
	body := jsonBody(t, api.CreateTeamRequest{Name: rawName, ExpectedUserID: actor})
	expected := teamHTTPCreate(t, db, handler.principal, rawName)
	response := teamComponentRequest(handler, "POST", "/api/v1/teams", body)
	team := decodeResponse[api.Team](t, response, 201)
	if team.Name == nil || *team.Name != rawName || team.ID != expected.ID || team.Kind != "ordinary" || team.Membership.UserID != actor || team.Membership.TeamID != team.ID || team.Membership.Role != "admin" || team.Membership.Version < 1 || team.Version != 1 {
		t.Fatalf("Team DTO %#v", team)
	}
	if response.Header().Get("Location") != "/api/v1/teams/"+team.ID || response.Header().Get("Daynight-User-ID") != actor || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Team headers %v", response.Header())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 7 {
		t.Fatalf("Team shape %s %v", response.Body, err)
	}
	teamHTTPRead(t, db, handler.principal, team.ID, *expected, nil)
	got := decodeResponse[api.Team](t, teamComponentRequest(handler, "GET", "/api/v1/teams/"+team.ID, ""), 200)
	if !reflect.DeepEqual(got, team) {
		t.Fatal("Team GET differs")
	}
	change := api.ChangeTeamRequest{Name: *team.Name, Version: team.Version, ExpectedUserID: actor}
	teamHTTPWrite(t, db, handler.principal, *expected, nil, false)
	same := decodeResponse[api.Team](t, teamComponentRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 200)
	if !reflect.DeepEqual(same, team) {
		t.Fatal("no-op changed Team")
	}
	change.Version = 2
	teamHTTPWrite(t, db, handler.principal, *expected, nil, false)
	assertProjectError(t, teamComponentRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 409, "version_conflict")
	change.Version = 1
	change.Name = " Renamed "
	renamedName := " Renamed "
	renamedExpected := *expected
	renamedExpected.Name = &renamedName
	renamedExpected.Version = 2
	renamedExpected.UpdatedAt = expected.UpdatedAt.Add(time.Second)
	teamHTTPWrite(t, db, handler.principal, *expected, &renamedExpected, false)
	renamed := decodeResponse[api.Team](t, teamComponentRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 200)
	if renamed.Version != 2 || *renamed.Name != change.Name || !reflect.DeepEqual(renamed.Membership, team.Membership) {
		t.Fatalf("renamed %#v", renamed)
	}
	change.Version = renamed.Version
	change.Name = "Renamed"
	teamHTTPWrite(t, db, handler.principal, renamedExpected, nil, false)
	assertProjectError(t, teamComponentRequest(handler, "DELETE", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 409, "version_conflict")
	change.Name = *renamed.Name
	teamHTTPWrite(t, db, handler.principal, renamedExpected, nil, true)
	deleted := teamComponentRequest(handler, "DELETE", "/api/v1/teams/"+team.ID, jsonBody(t, change))
	receipt := decodeResponse[api.DeleteTeamReceipt](t, deleted, 200)
	if receipt.TeamID != team.ID || !receipt.Deleted {
		t.Fatalf("delete receipt %#v", receipt)
	}
	fields = nil
	if err := json.Unmarshal(deleted.Body.Bytes(), &fields); err != nil || len(fields) != 2 {
		t.Fatalf("delete leaked other resource %s %v", deleted.Body, err)
	}
	teamHTTPRead(t, db, handler.principal, team.ID, model.Team{}, model.ErrNotFound)
	assertProjectError(t, teamComponentRequest(handler, "GET", "/api/v1/teams/"+team.ID, ""), 404, "not_found")
	personal := model.Team{TeamRef: model.TeamRef{ID: "c3333333-3333-4333-8333-333333333333", Kind: "personal"}, Version: 1, CreatedAt: expected.CreatedAt, UpdatedAt: expected.CreatedAt, Membership: model.TeamMember{TeamID: "c3333333-3333-4333-8333-333333333333", UserID: actor, Role: model.ProjectAdmin, Version: 1, CreatedAt: expected.CreatedAt, UpdatedAt: expected.CreatedAt}}
	teamHTTPList(t, db, handler.principal, []model.Team{personal})
	page := decodeResponse[api.TeamPage](t, teamComponentRequest(handler, "GET", "/api/v1/teams?limit=1", ""), 200)
	if page.Items == nil || len(page.Items) != 1 || page.Items[0].Kind != "personal" || page.Items[0].Name != nil || page.NextCursor != nil {
		t.Fatalf("Personal list %#v", page)
	}
	change.Name = "Personal"
	change.Version = page.Items[0].Version
	for _, method := range []string{"PATCH", "DELETE"} {
		teamHTTPWrite(t, db, handler.principal, personal, nil, false)
		assertProjectError(t, teamComponentRequest(handler, method, "/api/v1/teams/"+page.Items[0].ID, jsonBody(t, change)), 409, "personal_team_immutable")
	}
}

type teamHTTPReader struct {
	store.TeamReader
	t    *testing.T
	Read func(context.Context, string, string) (model.Team, error)
	List func(context.Context, string, store.Page) (store.TeamPage, error)
}

func (d teamHTTPReader) Team(ctx context.Context, user, id string) (model.Team, error) {
	return d.Read(ctx, user, id)
}
func (d teamHTTPReader) Teams(ctx context.Context, user string, page store.Page) (store.TeamPage, error) {
	return d.List(ctx, user, page)
}

type teamHTTPSnapshot struct {
	store.SnapshotScope
	reader store.TeamReader
}

func (s teamHTTPSnapshot) TeamDAO() store.TeamReader { return s.reader }

type teamHTTPCreator struct {
	store.TeamCreationDAO
	insert func(context.Context, string, string) (model.Team, error)
}

func (d teamHTTPCreator) InsertTeam(ctx context.Context, id, name string) (model.Team, error) {
	return d.insert(ctx, id, name)
}

type teamHTTPWriter struct {
	store.TeamWriteDAO
	read         func(context.Context, string) (model.Team, error)
	rename       func(context.Context, string, string) (model.Team, error)
	occupied     func(context.Context) (bool, error)
	delete       func(context.Context) error
	member       func(context.Context, string) (model.TeamMember, error)
	removeMember func(context.Context, string) error
}

func (d teamHTTPWriter) Team(ctx context.Context, user string) (model.Team, error) {
	return d.read(ctx, user)
}
func (d teamHTTPWriter) Rename(ctx context.Context, user, name string) (model.Team, error) {
	return d.rename(ctx, user, name)
}
func (d teamHTTPWriter) HasProjects(ctx context.Context) (bool, error) { return d.occupied(ctx) }
func (d teamHTTPWriter) Delete(ctx context.Context) error              { return d.delete(ctx) }

func (d teamHTTPWriter) Member(ctx context.Context, user string) (model.TeamMember, error) {
	return d.member(ctx, user)
}
func (d teamHTTPWriter) RemoveMember(ctx context.Context, user string) error {
	return d.removeMember(ctx, user)
}

type teamHTTPWriteScope struct {
	store.TeamWriteScope
	dao         store.TeamWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s teamHTTPWriteScope) TeamDAO() store.TeamWriteDAO                 { return s.dao }
func (s teamHTTPWriteScope) EligibilityDAO() store.WebhookEligibilityDAO { return s.eligibility }

type teamHTTPEligibility struct {
	store.WebhookEligibilityDAO
	lock func(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error)
}

func (d teamHTTPEligibility) LockAffected(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	return d.lock(ctx, f)
}

func teamHTTPCreate(t *testing.T, tx *httpTestStore, p model.Principal, name string) *model.Team {
	t.Helper()
	result := new(model.Team)
	writer, insert := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.CreateTeamCall = func(ctx context.Context, owner string, op func(store.TeamCreationDAO) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, owner, p.UserID)
		err := op(teamHTTPCreator{insert: func(ctx context.Context, id, raw string) (model.Team, error) {
			insert()
			projectHTTPCheck(t, raw, name)
			parsed, err := uuid.Parse(id)
			if err != nil || parsed.Version() != 4 {
				t.Errorf("Team ID is not allocated UUIDv4: %s %v", id, err)
				panic("invalid Team ID")
			}
			at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			*result = model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: at, UpdatedAt: at, Membership: model.TeamMember{TeamID: id, UserID: p.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: at, UpdatedAt: at}}
			return projectHTTPCopyTeam(*result), nil
		}})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
	return result
}
func teamHTTPRead(t *testing.T, tx *httpTestStore, p model.Principal, id string, result model.Team, readErr error) {
	t.Helper()
	snapshot, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshot()
		return op(teamHTTPSnapshot{reader: teamHTTPReader{t: t, Read: func(ctx context.Context, user, gotID string) (model.Team, error) {
			read()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, gotID, id)
			return projectHTTPCopyTeam(result), readErr
		}}})
	}
}
func teamHTTPList(t *testing.T, tx *httpTestStore, p model.Principal, items []model.Team) {
	t.Helper()
	snapshot, list := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshot()
		return op(teamHTTPSnapshot{reader: teamHTTPReader{t: t, List: func(ctx context.Context, user string, page store.Page) (store.TeamPage, error) {
			list()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, page, store.Page{Limit: 1})
			returned := slices.Clone(items)
			for index := range returned {
				returned[index] = projectHTTPCopyTeam(returned[index])
			}
			return store.TeamPage{Items: returned}, nil
		}}})
	}
}
func teamHTTPWrite(t *testing.T, tx *httpTestStore, p model.Principal, current model.Team, rename *model.Team, remove bool) {
	t.Helper()
	writer, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := teamHTTPWriter{read: func(ctx context.Context, user string) (model.Team, error) {
		read()
		projectHTTPCheck(t, user, p.UserID)
		return projectHTTPCopyTeam(current), nil
	}}
	if rename != nil {
		called := projectHTTPCount(t, 1)
		dao.rename = func(ctx context.Context, user, name string) (model.Team, error) {
			called()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, name, *rename.Name)
			return projectHTTPCopyTeam(*rename), nil
		}
	}
	var eligibility store.WebhookEligibilityDAO
	if remove {
		occupied, deleted, locked := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		dao.occupied = func(context.Context) (bool, error) { occupied(); return false, nil }
		dao.delete = func(context.Context) error { deleted(); return nil }
		eligibility = teamHTTPEligibility{lock: func(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
			locked()
			projectHTTPCheck(t, f, store.WebhookEligibilityFilter{TeamID: current.ID, TeamOwner: true})
			return nil, nil
		}}
	}
	tx.WriteTeamCall = func(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, id, current.ID)
		err := op(teamHTTPWriteScope{dao: dao, eligibility: eligibility})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func projectHTTPCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected Project DAO argument/result: got %#v, want %#v", got, want)
		panic("Project DAO contract violated")
	}
}
func projectHTTPCount(t *testing.T, want int) func() {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != want {
			t.Errorf("Project DAO call count: got %d, want %d", calls, want)
		}
	})
	return func() {
		calls++
		if calls > want {
			t.Errorf("extra Project DAO call: %d > %d", calls, want)
			panic("extra Project DAO call")
		}
	}
}
func projectHTTPCopyPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func projectHTTPCopyTeam(value model.Team) model.Team {
	value.Name = projectHTTPCopyPointer(value.Name)
	return value
}

type httpTestStore struct {
	t                *testing.T
	ReadSnapshotCall func(context.Context, func(store.SnapshotScope) error) error
	CreateTeamCall   func(context.Context, string, func(store.TeamCreationDAO) error) (store.Completion, error)
	WriteTeamCall    func(context.Context, string, func(store.TeamWriteScope) error) (store.Completion, error)
}

func (s *httpTestStore) ReadSnapshot(ctx context.Context, op func(store.SnapshotScope) error) error {
	if s.ReadSnapshotCall == nil {
		s.t.Fatal("unexpected ReadSnapshot")
	}
	return s.ReadSnapshotCall(ctx, op)
}
func (s *httpTestStore) CreateTeam(ctx context.Context, owner string, op func(store.TeamCreationDAO) error) (store.Completion, error) {
	if s.CreateTeamCall == nil {
		s.t.Fatal("unexpected CreateTeam")
	}
	return s.CreateTeamCall(ctx, owner, op)
}
func (s *httpTestStore) WriteTeam(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
	if s.WriteTeamCall == nil {
		s.t.Fatal("unexpected WriteTeam")
	}
	return s.WriteTeamCall(ctx, id, op)
}
func newHTTPTestStore(t *testing.T) *httpTestStore { return &httpTestStore{t: t} }

type teamComponentHandler struct {
	http.Handler
	principal model.Principal
}

func teamComponentHost(t *testing.T, db *httpTestStore, output io.Writer) *teamComponentHandler {
	t.Helper()
	principal := model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if kind != model.PATCredential || token != "team-controlled-token" {
			return model.Principal{}, authhttp.Failure()
		}
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, teamservice.NewTeams(db), &authhttp.Authentication{RequestAuthentication: auth}, logger)
	return &teamComponentHandler{Handler: httpx.RequestLogging(logger, mux), principal: principal}
}
func teamComponentRequest(handler *teamComponentHandler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer team-controlled-token")
	req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	req.Header.Set("X-Request-ID", "project-test")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}
