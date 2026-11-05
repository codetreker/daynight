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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestInstalledCLITeamLifecycleAndUnknownAfterRealCommit(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_team_lifecycle_unknown", []string{"V17", "V20"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		user := acceptanceDecode[api.User](t, process.request(context.Background(), http.MethodGet, "/api/v1/me", nil, "team-lifecycle-me"), http.StatusOK)
		originalName := "  Team\nwith\rcontrols\tand\\backslash  "
		created := acceptanceCLIJSON[api.Team](t, cli.run(t, cli.caller, "team", "create", originalName, "--confirm", "--json"))
		if created.Kind != "ordinary" || created.Name == nil || *created.Name != originalName || created.Membership.UserID != user.ID || created.Membership.Role != "admin" || created.Version != 1 {
			t.Fatal("installed CLI creation did not return the real Team and principal")
		}
		teamPath := "/api/v1/teams/" + created.ID
		stored := acceptanceDecode[api.Team](t, process.request(context.Background(), http.MethodGet, teamPath, nil, "team-lifecycle-created"), http.StatusOK)
		if stored.Name == nil || *stored.Name != originalName || stored.Version != created.Version {
			t.Fatal("confirmed Team creation was not stored exactly")
		}

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
			var data []byte
			if request.Body != nil {
				var readErr error
				data, readErr = io.ReadAll(io.LimitReader(request.Body, 1<<20+1))
				if readErr != nil {
					t.Error(readErr)
				}
				request.Body = io.NopCloser(strings.NewReader(string(data)))
			}
			mutex.Lock()
			observed = append(observed, observedRequest{request.Method, request.URL.Path, request.Header.Get("X-Request-ID"), request.Header.Get("Authorization"), data})
			mutex.Unlock()
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			if response.Request.Method == http.MethodPatch && response.Request.URL.Path == teamPath && response.StatusCode == http.StatusOK {
				if err := response.Body.Close(); err != nil {
					t.Error("cannot close lost Team rename response")
				}
				return errors.New("private proxy loss after actual Team commit")
			}
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
		server := httptest.NewServer(proxy)
		t.Cleanup(server.Close)
		cli.configure(t, &acceptanceProcess{origin: server.URL, token: process.token})
		newName := " changed\nname\\ "
		result := acceptanceCLIReceive(t, cli.start(t, cli.caller, "team", "rename", newName, "--team", created.ID, "--confirm", "--json"))
		mutex.Lock()
		requests := append([]observedRequest{}, observed...)
		mutex.Unlock()
		if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "outcome is unknown") || len(requests) != 3 || requests[0].method != http.MethodGet || requests[0].path != "/api/v1/me" || requests[1].method != http.MethodGet || requests[1].path != teamPath || requests[2].method != http.MethodPatch || requests[2].path != teamPath {
			t.Fatalf("unknown Team rename did not retain one write: status=%d requests=%d", result.status, len(requests))
		}
		write := requests[2]
		var body api.ChangeTeamRequest
		if json.Unmarshal(write.body, &body) != nil || body.ExpectedUserID != user.ID || body.Version != created.Version || body.Name != newName || write.authorization != "Bearer "+process.token {
			t.Fatal("Team rename request did not retain exact observed preconditions")
		}
		if _, err := uuid.Parse(write.id); err != nil || !strings.Contains(result.stderr, "requestId="+write.id) || strings.Contains(result.stderr, process.token) || strings.Contains(result.stderr, "private proxy loss") {
			t.Fatal("unknown Team rename lost its safe request identity or exposed private data")
		}
		current := acceptanceDecode[api.Team](t, process.request(context.Background(), http.MethodGet, teamPath, nil, "team-lifecycle-after-loss"), http.StatusOK)
		if current.Name == nil || *current.Name != newName || current.Version != created.Version+1 {
			t.Fatal("lost response did not follow one committed Team rename")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		connection, err := pgx.Connect(ctx, fixture.url(t, fixture.schema+"_team_observation"))
		if err != nil {
			t.Fatal("cannot connect to isolated Team database for observation")
		}
		var persistedName string
		var persistedVersion int64
		err = connection.QueryRow(ctx, "SELECT name, version FROM teams WHERE id=$1", created.ID).Scan(&persistedName, &persistedVersion)
		closeErr := connection.Close(ctx)
		if err != nil || closeErr != nil || persistedName != newName || persistedVersion != created.Version+1 {
			t.Fatal("new database connection did not observe the single committed rename")
		}
		cli.configure(t, process)
		deleted := acceptanceCLIJSON[api.DeleteTeamReceipt](t, cli.run(t, cli.caller, "team", "delete", "--team", created.ID, "--confirm", "--json"))
		if !deleted.Deleted || deleted.TeamID != created.ID {
			t.Fatal("Team deletion receipt did not identify the target")
		}
		response := process.request(context.Background(), http.MethodGet, teamPath, nil, "team-lifecycle-after-delete")
		if response.err != nil || response.status != http.StatusNotFound {
			t.Fatal("confirmed Team deletion was not stored")
		}
		process.signal(t)
		process.stopped(t, 0)
	})
}
