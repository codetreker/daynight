package team

import (
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

type authHarness = testsupport.AuthHarness[*authhttp.Authentication]

type teamIntegrationFixture struct {
	database *postgres.Store
	identity *identityservice.Identity
	origin   string
}

type teamHTTPCase struct {
	*authHarness
	loginSuffix string
}

func newTeamAuthentication(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
	return authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
}

func newTeamIntegrationFixture(t *testing.T) teamIntegrationFixture {
	t.Helper()
	parent := testsupport.NewAuthHarness(t, newTeamAuthentication)
	return teamIntegrationFixture{database: parent.Database, identity: parent.Identity, origin: parent.Origin}
}

func (f teamIntegrationFixture) forCase(t *testing.T) *teamHTTPCase {
	t.Helper()
	h := &authHarness{Database: f.database, Identity: f.identity, Origin: f.origin}
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	var err error
	h.Auth, err = newTeamAuthentication(h.Identity, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	RegisterRoutes(mux, teamservice.NewTeams(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	return &teamHTTPCase{authHarness: h, loginSuffix: "-" + strings.ReplaceAll(t.Name(), "/", "-")}
}

func (h *teamHTTPCase) Login(t *testing.T, code string) *http.Cookie {
	t.Helper()
	return h.authHarness.Login(t, code+h.loginSuffix)
}

func TestTeamHTTPPostgres(t *testing.T) {
	fixture := newTeamIntegrationFixture(t)
	for _, scenario := range []struct {
		name string
		run  func(*testing.T, teamIntegrationFixture)
	}{
		// The whole-table snapshot runs before other scenarios add Team rows.
		{"metadata_limits", testTeamHTTPMetadataLimitsPreserveRows},
		{"session_pat_and_identity_permissions", testTeamHTTPSessionPATAndIdentityPermissions},
		{"strict_input_and_pagination", testTeamHTTPStrictInputAndPagination},
		{"page_count_and_cursor", testTeamHTTPPageCountAndCursor},
		{"members", testTeamMembersHTTP},
		{"members_concurrent_last_admin", testTeamMembersConcurrentLastAdmin},
		{"invitations", testTeamInvitationHTTP},
		{"invitation_refusals_and_revoke", testTeamInvitationHTTPRefusalsAndRevoke},
		{"committed_writes_survive_lost_http_responses", testTeamCommittedWritesSurviveLostHTTPResponses},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			scenario.run(t, fixture)
		})
	}
}

func jsonBody(t *testing.T, input any) string { return testsupport.JSONBody(t, input) }
func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	short bool
	calls int
}

func (w *threadFailingWriter) Write(data []byte) (int, error) {
	w.calls++
	if w.short {
		return 0, nil
	}
	return 0, errors.New("private response failure")
}

type teamResourceHandler struct {
	http.Handler
	database  *postgres.Store
	principal model.Principal
	cookie    *http.Cookie
	origin    string
}

func teamTestHandler(t *testing.T, fixture teamIntegrationFixture) *teamResourceHandler {
	t.Helper()
	h := fixture.forCase(t)
	cookie := h.Login(t, "team-resource")
	user := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{cookie}, nil, ""), 200)
	return &teamResourceHandler{Handler: h.Handler, database: h.Database, principal: model.Principal{UserID: user.ID}, cookie: cookie, origin: h.Origin}
}

func projectRequest(handler *teamResourceHandler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.AddCookie(handler.cookie)
	request.Header.Set("Origin", handler.origin)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
