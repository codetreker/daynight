package e2e_tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

func TestInstalledWorkerProjectIsolationServiceAcceptance(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("controlled Herdr process fixture requires Linux")
	}
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "worker_project_isolation_real_service", []string{"PD11"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		alice := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		browser := testauth.Browser(t)
		testauth.Login(t, browser, alice.origin, "bob")
		bobToken := testauth.CreatePAT(t, browser, alice.origin)
		browser.CloseIdleConnections()
		bob := *alice
		bob.token = bobToken
		aliceUser := acceptanceDecode[api.User](t, alice.request(context.Background(), http.MethodGet, "/api/v1/me", nil, ""), http.StatusOK)
		bobUser := acceptanceDecode[api.User](t, bob.request(context.Background(), http.MethodGet, "/api/v1/me", nil, ""), http.StatusOK)
		if aliceUser.ID == bobUser.ID {
			t.Fatal("fixture identities must differ")
		}
		a := bob.project(t, "Unavailable A")
		b := acceptanceDecode[api.Project](t, alice.request(context.Background(), http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{ExpectedUserID: aliceUser.ID, Name: "Healthy B", RepoURL: "https://github.com/example/healthy-repo"}, ""), http.StatusCreated)
		// A different Project with the same repository must not replace the explicit A ID.
		_ = acceptanceDecode[api.Project](t, alice.request(context.Background(), http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{ExpectedUserID: aliceUser.ID, Name: "Replacement A2", RepoURL: a.RepoURL}, ""), http.StatusCreated)
		invitation := acceptanceDecode[api.CreatedProjectInvitation](t, bob.request(context.Background(), http.MethodPost, "/api/v1/projects/"+a.ID+"/invitations", api.ProjectInvitationMutationRequest{ExpectedUserID: bobUser.ID}, ""), http.StatusCreated)
		link, err := url.Parse(invitation.Link)
		if err != nil {
			t.Fatal("invalid invitation link")
		}
		accepted := acceptanceDecode[api.ProjectInvitationAcceptance](t, alice.request(context.Background(), http.MethodPost, "/api/v1/invitations/accept", api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: aliceUser.ID}, ""), http.StatusOK)
		aTask := bob.task(t, a, "Retained A claim")
		aTask = bob.update(t, aTask, map[string]any{"assignedTo": aliceUser.ID})
		aTask = bob.update(t, aTask, map[string]any{"allowAgents": true})
		bTask := alice.task(t, b, "Healthy B execution")
		bTask = alice.update(t, bTask, map[string]any{"assignedTo": aliceUser.ID})
		bTask = alice.update(t, bTask, map[string]any{"allowAgents": true})
		input, err := json.Marshal(map[string]any{"serverUrl": alice.origin, "aliceToken": alice.token, "bobToken": bob.token, "aliceId": aliceUser.ID, "bobId": bobUser.ID, "grantVersion": accepted.DirectGrant.Version, "a": a, "b": b, "aTaskId": aTask.ID, "packageVersion": receipt.PackageVersion})
		if err != nil {
			t.Fatal("cannot encode test input")
		}
		program, err := filepath.Abs("worker_project_isolation_agent.mjs")
		if err != nil {
			t.Fatal("cannot locate worker fixture")
		}
		result := acceptanceCLIReceive(t, cli.startProgram(t, cli.caller, program, strings.NewReader(string(input)), filepath.Dir(receipt.EntryPath)))
		if result.status != 0 || result.stderr != "" || result.stdout != "real-service-worker-isolation-ok\n" {
			t.Fatalf("installed worker service fixture failed (%d): %s", result.status, result.stderr)
		}
		finalA := bob.readTask(t, aTask)
		workerA := acceptanceWorker(t, finalA.Properties)
		if finalA.Status != "in_progress" || workerA == nil || workerA.State != "active" {
			t.Fatal("revoked A claim was not retained")
		}
		finalB := alice.readTask(t, bTask)
		workerB := acceptanceWorker(t, finalB.Properties)
		if finalB.Status != "done" || workerB == nil || workerB.State != "completed" {
			t.Fatal("fixture agent did not complete B claim")
		}
		participants := acceptanceDecode[api.ProjectParticipantList](t, bob.request(context.Background(), http.MethodGet, "/api/v1/projects/"+a.ID+"/members", nil, ""), http.StatusOK)
		var version int64
		for _, participant := range participants.Items {
			if participant.UserID == aliceUser.ID && participant.DirectGrant != nil {
				version = participant.DirectGrant.Version
			}
		}
		if version == 0 {
			t.Fatal("restored project grant is missing")
		}
		removed := bob.request(context.Background(), http.MethodDelete, "/api/v1/projects/"+a.ID+"/members/"+aliceUser.ID, api.RemoveProjectMemberRequest{Version: version, ExpectedUserID: bobUser.ID}, "")
		if removed.err != nil || removed.status != http.StatusNoContent {
			t.Fatal("could not revoke project access for runtime fixture")
		}
		taskIDs := make([]string, 0, 4)
		for index := 0; index < 4; index++ {
			task := alice.task(t, b, "Installed worker fixture")
			task = alice.update(t, task, map[string]any{"assignedTo": aliceUser.ID})
			if index == 0 {
				task = alice.update(t, task, map[string]any{"allowAgents": true})
			}
			taskIDs = append(taskIDs, task.ID)
		}
		runtimeInput, err := json.Marshal(map[string]any{"serverUrl": alice.origin, "aliceToken": alice.token, "bobToken": bob.token, "aliceId": aliceUser.ID, "bobId": bobUser.ID, "a": a, "b": b, "aTaskId": aTask.ID, "aClaimId": workerA.ClaimID, "taskIds": taskIDs})
		if err != nil {
			t.Fatal("cannot encode worker runtime input")
		}
		runtimeProgram, err := filepath.Abs("worker_project_isolation_runtime.mjs")
		if err != nil {
			t.Fatal("cannot locate worker runtime fixture")
		}
		daemon, err := filepath.Abs("worker_project_isolation_daemon.mjs")
		if err != nil {
			t.Fatal("cannot locate worker daemon fixture")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, receipt.NodePath, runtimeProgram, receipt.EntryPath, daemon)
		command.Dir, command.Env, command.Stdin = cli.caller, cli.environment(), strings.NewReader(string(runtimeInput))
		command.Cancel = func() error { return command.Process.Signal(os.Interrupt) }
		command.WaitDelay = 10 * time.Second
		var stdout, stderr acceptanceCLIOutput
		command.Stdout, command.Stderr = &stdout, &stderr
		if err := binaryAcceptance.update(func() { scenario.CLIProcessesStarted++ }); err != nil {
			t.Fatal("cannot record worker fixture start")
		}
		err = command.Run()
		if updateErr := binaryAcceptance.update(func() { scenario.CLIProcessesReaped++ }); updateErr != nil {
			t.Fatal("cannot record worker fixture exit")
		}
		if err != nil || stdout.String() != "real-service-installed-worker-ok\n" || stderr.Len() != 0 {
			t.Fatalf("installed worker runtime fixture failed: %v: %s", err, stderr.String())
		}
		for _, taskID := range taskIDs[:3] {
			task := acceptanceDecode[api.Task](t, alice.request(context.Background(), http.MethodGet, acceptanceTasksPath(b.ID)+"/"+taskID, nil, ""), http.StatusOK)
			if task.Status != "done" || acceptanceWorker(t, task.Properties).State != "completed" {
				t.Fatal("installed worker fixture did not complete its task")
			}
		}
		released := acceptanceDecode[api.Task](t, alice.request(context.Background(), http.MethodGet, acceptanceTasksPath(b.ID)+"/"+taskIDs[3], nil, ""), http.StatusOK)
		if worker := acceptanceWorker(t, released.Properties); released.Status != "todo" || worker == nil || worker.State != "released" {
			t.Fatal("native B release did not persist")
		}
		alice.signal(t)
		alice.stopped(t, 0)
	})
}
