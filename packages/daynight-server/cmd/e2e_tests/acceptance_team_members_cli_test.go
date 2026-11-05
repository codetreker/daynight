package e2e_tests

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestInstalledCLITeamMembersAndUnknownAfterRealCommit(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_team_members_unknown", []string{"V2", "V5", "V8", "V17", "V18", "V20"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		user := acceptanceDecode[api.User](t, process.request(context.Background(), http.MethodGet, "/api/v1/me", nil, "team-members-me"), http.StatusOK)
		browser := testauth.Browser(t)
		testauth.Login(t, browser, process.origin, "bob")
		response, err := browser.Get(process.origin + "/api/v1/me")
		if err != nil {
			t.Fatal("cannot read second Team member")
		}
		var other api.User
		decodeErr := json.NewDecoder(response.Body).Decode(&other)
		closeErr := response.Body.Close()
		browser.CloseIdleConnections()
		if response.StatusCode != http.StatusOK || decodeErr != nil || closeErr != nil || other.ID == user.ID {
			t.Fatal("second Team member is not a distinct canonical user")
		}

		created := acceptanceCLIJSON[api.Team](t, cli.run(t, cli.caller, "team", "create", "Members", "--confirm", "--json"))
		for _, args := range [][]string{
			{"team", "leave", "--team", "personal", "--confirm"},
			{"team", "member", "set-role", user.ID, "member", "--team", "personal", "--confirm"},
		} {
			result := acceptanceCLIReceive(t, cli.start(t, cli.caller, args...))
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "personal_team_immutable") {
				t.Fatalf("Personal Team membership refusal not exposed: status=%d stderr=%s", result.status, result.stderr)
			}
		}
		for _, args := range [][]string{
			{"team", "member", "set-role", user.ID, "member", "--team", created.ID, "--confirm"},
			{"team", "leave", "--team", created.ID, "--confirm"},
		} {
			result := acceptanceCLIReceive(t, cli.start(t, cli.caller, args...))
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "last_admin") {
				t.Fatalf("last administrator refusal not exposed: status=%d stderr=%s", result.status, result.stderr)
			}
		}
		fixture.exec(t, "SELECT setval('team_member_versions', 9007199254740993, true)")
		fixture.exec(t, "UPDATE team_members SET version=$3 WHERE team_id=$1 AND user_id=$2", created.ID, user.ID, int64(9007199254740993))
		fixture.exec(t, "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')", created.ID, other.ID)
		fixture.exec(t, "UPDATE users SET name=NULL,email=NULL,avatar_url=NULL WHERE id=$1", other.ID)
		project := process.project(t, "Team member grant preservation")
		fixture.exec(t, "UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1", project.ID, created.ID)
		fixture.exec(t, "INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')", project.ID, other.ID)
		grantFor := func(projectID, id string) string {
			t.Helper()
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			var row string
			if err := fixture.admin.QueryRow(ctx, "SELECT row_to_json(g)::text FROM project_grants g WHERE project_id=$1 AND user_id=$2", projectID, id).Scan(&row); err != nil {
				t.Fatal("cannot read independent Project grant")
			}
			return row
		}
		grant := func(id string) string { return grantFor(project.ID, id) }
		userGrant, otherGrant := grant(user.ID), grant(other.ID)
		adminExitTeam := acceptanceCLIJSON[api.Team](t, cli.run(t, cli.caller, "team", "create", "Admin exit", "--confirm", "--json"))
		fixture.exec(t, "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')", adminExitTeam.ID, other.ID)
		adminProject := process.project(t, "Administrator exit grant preservation")
		fixture.exec(t, "UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1", adminProject.ID, adminExitTeam.ID)
		adminGrant := grantFor(adminProject.ID, user.ID)
		adminExit := acceptanceCLIJSON[api.RemoveTeamMemberReceipt](t, cli.run(t, cli.caller, "team", "leave", "--team", adminExitTeam.ID, "--if-version", strconv.FormatInt(adminExitTeam.Membership.Version, 10), "--confirm", "--json"))
		if !adminExit.Removed || adminExit.TeamID != adminExitTeam.ID || adminExit.UserID != user.ID || adminExit.ActorRole != nil {
			t.Fatal("administrator exit with another administrator did not return the committed receipt")
		}
		if grantFor(adminProject.ID, user.ID) != adminGrant {
			t.Fatal("administrator exit changed the Team project's independent grant")
		}
		members := acceptanceCLIJSON[[]api.TeamMemberWithProfile](t, cli.run(t, cli.caller, "team", "member", "list", "--team", created.ID, "--json"))
		foundUser, foundOther := false, false
		for _, member := range members {
			if member.UserID == user.ID {
				foundUser = member.Version == 9007199254740993 && member.Role == "admin"
			}
			if member.UserID == other.ID {
				foundOther = member.Role == "admin" && member.Profile.Name == nil && member.Profile.Email == nil && member.Profile.AvatarURL == nil
			}
		}
		if len(members) != 2 || !foundUser || !foundOther {
			t.Fatal("installed Team directory lost the exact version or nullable profile")
		}
		demoted := acceptanceCLIJSON[api.TeamMemberRoleReceipt](t, cli.run(t, cli.caller, "team", "member", "set-role", user.ID, "member", "--team", created.ID, "--if-version", "9007199254740993", "--confirm", "--json"))
		if demoted.Membership.UserID != user.ID || demoted.Membership.Role != "member" || demoted.Membership.Version <= 9007199254740993 || demoted.ActorRole == nil || *demoted.ActorRole != "member" {
			t.Fatal("self-demotion did not return the real relation and actor role")
		}
		if grant(user.ID) != userGrant || grant(other.ID) != otherGrant {
			t.Fatal("self-demotion changed independent Project grants")
		}
		left := acceptanceCLIJSON[api.RemoveTeamMemberReceipt](t, cli.run(t, cli.caller, "team", "leave", "--team", created.ID, "--if-version", strconv.FormatInt(demoted.Membership.Version, 10), "--confirm", "--json"))
		if !left.Removed || left.TeamID != created.ID || left.UserID != user.ID || left.ActorRole != nil {
			t.Fatal("successful self-exit did not return the committed receipt")
		}
		if grant(user.ID) != userGrant || grant(other.ID) != otherGrant {
			t.Fatal("self-exit changed independent Project grants")
		}
		forbidden := process.request(context.Background(), http.MethodGet, "/api/v1/teams/"+created.ID+"/members", nil, "team-members-after-leave")
		if forbidden.err != nil || forbidden.status != http.StatusNotFound {
			t.Fatal("self-exit did not revoke the Team directory")
		}
		projectAfter := process.request(context.Background(), http.MethodGet, "/api/v1/projects/"+project.ID, nil, "team-members-project-after-leave")
		if projectAfter.err != nil || projectAfter.status != http.StatusOK {
			t.Fatal("self-exit discarded access provided by the independent Project grant")
		}

		unknownTeam := acceptanceCLIJSON[api.Team](t, cli.run(t, cli.caller, "team", "create", "Unknown removal", "--confirm", "--json"))
		fixture.exec(t, "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')", unknownTeam.ID, other.ID)
		fixture.exec(t, "UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1", project.ID, unknownTeam.ID)
		if grant(user.ID) != userGrant || grant(other.ID) != otherGrant {
			t.Fatal("Team ownership setup changed independent Project grants")
		}
		var observedVersion int64
		versionCtx, versionCancel := context.WithTimeout(context.Background(), 8*time.Second)
		versionErr := fixture.admin.QueryRow(versionCtx, "SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2", unknownTeam.ID, other.ID).Scan(&observedVersion)
		versionCancel()
		if versionErr != nil {
			t.Fatal("cannot observe the member version before removal")
		}
		teamPath := "/api/v1/teams/" + unknownTeam.ID
		memberPath := teamPath + "/members/" + other.ID
		target, err := url.Parse(process.origin)
		if err != nil {
			t.Fatal(err)
		}
		type observedRequest struct {
			method, path, id, authorization string
			body                            []byte
		}
		var mutex sync.Mutex
		var observed []observedRequest
		proxy := httputil.NewSingleHostReverseProxy(target)
		director := proxy.Director
		proxy.Director = func(request *http.Request) {
			director(request)
			var body []byte
			if request.Body != nil {
				var readErr error
				body, readErr = io.ReadAll(io.LimitReader(request.Body, 1<<20+1))
				if readErr != nil {
					t.Error(readErr)
				}
				request.Body = io.NopCloser(strings.NewReader(string(body)))
			}
			mutex.Lock()
			observed = append(observed, observedRequest{request.Method, request.URL.Path, request.Header.Get("X-Request-ID"), request.Header.Get("Authorization"), body})
			mutex.Unlock()
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			if response.Request.Method == http.MethodDelete && response.Request.URL.Path == memberPath && response.StatusCode == http.StatusOK {
				if err := response.Body.Close(); err != nil {
					t.Error("cannot close lost Team membership response")
				}
				return errors.New("private proxy loss after actual Team membership commit")
			}
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
		server := httptest.NewServer(proxy)
		t.Cleanup(server.Close)
		cli.configure(t, &acceptanceProcess{origin: server.URL, token: process.token})
		result := acceptanceCLIReceive(t, cli.start(t, cli.caller, "team", "member", "remove", other.ID, "--team", unknownTeam.ID, "--confirm", "--json"))
		mutex.Lock()
		requests := append([]observedRequest{}, observed...)
		mutex.Unlock()
		if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "outcome is unknown") || len(requests) != 3 || requests[0].method != http.MethodGet || requests[0].path != "/api/v1/me" || requests[1].method != http.MethodGet || requests[1].path != teamPath+"/members" || requests[2].method != http.MethodDelete || requests[2].path != memberPath {
			t.Fatalf("unknown removal did not retain one write: status=%d requests=%d", result.status, len(requests))
		}
		write := requests[2]
		var body api.RemoveTeamMemberRequest
		if json.Unmarshal(write.body, &body) != nil || body.ExpectedUserID != user.ID || body.Version != observedVersion || write.authorization != "Bearer "+process.token {
			t.Fatal("removal did not submit the observed membership and principal")
		}
		if _, err := uuid.Parse(write.id); err != nil || !strings.Contains(result.stderr, "requestId="+write.id) || strings.Contains(result.stderr, process.token) || strings.Contains(result.stderr, "private proxy loss") {
			t.Fatal("unknown removal lost its safe request identity or exposed private data")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		connection, err := pgx.Connect(ctx, fixture.url(t, fixture.schema+"_member_observation"))
		if err != nil {
			t.Fatal("cannot connect to isolated Team database for observation")
		}
		var remaining int
		err = connection.QueryRow(ctx, "SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2", unknownTeam.ID, other.ID).Scan(&remaining)
		closeErr = connection.Close(ctx)
		if err != nil || closeErr != nil || remaining != 0 || grant(user.ID) != userGrant || grant(other.ID) != otherGrant {
			t.Fatal("independent observation did not confirm removal and unchanged Project grants")
		}
		process.signal(t)
		process.stopped(t, 0)
	})
}
