package project_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

type claimBarrierStore struct {
	*postgres.Store
	prepared chan error
	release  chan struct{}
}

func (s *claimBarrierStore) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error {
		err := work(scope)
		s.prepared <- err
		if err != nil {
			return err
		}
		select {
		case <-s.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

type repositoryObserver struct{ target int64 }

func (o *repositoryObserver) ObserveRepository(_ context.Context, _ store.GitHubProjectAppFacts, _ *store.GitHubProjectApp, _ string) coreproject.RepositoryEvidence {
	old := int64(30)
	return coreproject.RepositoryEvidence{OldID: &old, TargetID: &o.target, TargetFullName: "acme/reused", TargetPrivate: true}
}

func TestRepositoryHTTPRealServiceAndDatabase(t *testing.T) {
	db := testutil.OpenStore(t, postgres.Open)
	_, actor, _ := testutil.AuthRecords(t, db)
	_, outsider, _ := testutil.AuthRecords(t, db)
	app := projectservice.NewAppProjects(db)
	p, err := app.Create(t.Context(), actor, coreproject.CreateProject{Name: "HTTP repository", RepoURL: "https://github.com/acme/original", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	occupied, err := app.Create(t.Context(), actor, coreproject.CreateProject{Name: "Occupied", RepoURL: "https://example.com/occupied", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	other := uuid.NewString()
	for i, user := range []string{actor.UserID, outsider.UserID} {
		raw := `{"future":{"retain":true},"projects":[{"projectId":"` + p.ID + `","custom":true},{"projectId":"` + other + `","future":"retained"}]}`
		lastSeen := time.Now().UTC()
		if i == 1 {
			lastSeen = lastSeen.Add(-96 * time.Hour)
		}
		_, err = db.Pool.Exec(t.Context(), `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration,configuration_observation_revision,configuration_observation,archive_sessions) VALUES($1,$2,now(),$3,'{}','{}',$4,now(),$5,7,'{"future":"observation"}',false)`, user, uuid.NewString(), lastSeen, int64(4+i), raw)
		if err != nil {
			t.Fatal(err)
		}
	}
	const origin = "http://127.0.0.1:8787"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if kind != model.SessionCredential {
			return model.Principal{}, authhttp.Failure()
		}
		switch secret {
		case "admin":
			return actor, nil
		case "outsider":
			return outsider, nil
		default:
			return model.Principal{}, authhttp.Failure()
		}
	}, authconfig.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	projecthttp.RegisterRoutes(mux, app, auth, logger)
	server := httptest.NewServer(httpx.RequestLogging(logger, mux))
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	path := "/api/v1/projects/" + p.ID + "/repository"
	call := func(method, path, secret string, body any, status int) []byte {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(t.Context(), method, server.URL+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "daynight_session", Value: secret})
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		result, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != status || res.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s status=%d body=%s", method, path, res.StatusCode, result)
		}
		return result
	}
	preview := func(address string) api.RepositoryPreview {
		t.Helper()
		var result api.RepositoryPreview
		raw := call("POST", path+"/preview", "admin", map[string]any{"repoUrl": address, "expectedUserId": actor.UserID}, 200)
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	input := func(value api.RepositoryPreview, choice bool) map[string]any {
		return map[string]any{"repoUrl": value.RepoURL, "expectedUserId": actor.UserID, "repositoryVersion": value.RepositoryVersion, "ownershipVersion": value.OwnershipVersion, "classification": value.Classification, "targetGitHubRepositoryId": value.TargetGitHubRepositoryID, "treatUnverifiedAsSwitch": choice}
	}
	assertCode := func(raw []byte, code string) {
		t.Helper()
		var result api.ErrorResponse
		if err := json.Unmarshal(raw, &result); err != nil || result.Error.Code != code {
			t.Fatalf("expected %s: %s (%v)", code, raw, err)
		}
	}
	call("POST", path+"/preview", "outsider", map[string]any{"repoUrl": "https://example.com/new", "expectedUserId": outsider.UserID}, 404)
	unchanged := preview(p.RepoURL)
	if unchanged.Classification != "unchanged" || unchanged.RepositoryVersion != "1" || unchanged.BindingsInvalidated {
		t.Fatalf("unchanged: %+v", unchanged)
	}
	same := preview("git@github.com:acme/original.git")
	if same.Classification != "same_repository" || same.BindingsInvalidated {
		t.Fatalf("same: %+v", same)
	}
	var receipt api.RepositoryReceipt
	if err := json.Unmarshal(call("PATCH", path, "admin", input(same, false), 200), &receipt); err != nil || !receipt.Changed || receipt.BindingsInvalidated || receipt.RepositoryVersion != "2" {
		t.Fatalf("same save: %+v %v", receipt, err)
	}
	assertCode(call("PATCH", path, "admin", input(same, false), 409), "version_conflict")
	conflict := preview(occupied.RepoURL)
	assertCode(call("PATCH", path, "admin", input(conflict, true), 409), "project_repository_conflict")
	unknown := preview("https://example.com/new")
	if unknown.Classification != "unverified" || unknown.UnverifiedReason == nil || !unknown.BindingsInvalidated || unknown.TargetGitHubRepositoryID != nil {
		t.Fatalf("unverified: %+v", unknown)
	}
	assertCode(call("PATCH", path, "admin", input(unknown, false), 400), "invalid_input")
	if err := json.Unmarshal(call("PATCH", path, "admin", input(unknown, true), 200), &receipt); err != nil || !receipt.Changed || !receipt.BindingsInvalidated || receipt.RepositoryVersion != "3" {
		t.Fatalf("switch: %+v %v", receipt, err)
	}
	var saved string
	if err := db.Pool.QueryRow(t.Context(), `SELECT repo_url FROM projects WHERE id=$1`, p.ID).Scan(&saved); err != nil || saved != "https://example.com/new" {
		t.Fatalf("saved address=%s err=%v", saved, err)
	}
	rows, err := db.Pool.Query(t.Context(), `SELECT configuration_revision,configuration_observation_revision,configuration_observation,archive_sessions,desired_configuration FROM workers ORDER BY configuration_revision`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var revisions []int64
	for rows.Next() {
		var revision, observationRevision int64
		var observation, raw []byte
		var archive bool
		if err := rows.Scan(&revision, &observationRevision, &observation, &archive, &raw); err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"future": map[string]any{"retain": true}, "projects": []any{map[string]any{"projectId": other, "future": "retained"}}}
		if observationRevision != 7 || archive || string(observation) != `{"future": "observation"}` || !reflect.DeepEqual(value, want) {
			t.Fatalf("worker configuration=%v observation=%s revision=%d", value, observation, revision)
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(revisions, []int64{5, 6}) {
		t.Fatalf("worker revisions=%v", revisions)
	}
	rows.Close()

	// The same normalized path can now identify a different GitHub repository.
	reused, err := app.Create(t.Context(), actor, coreproject.CreateProject{Name: "Reused", RepoURL: "https://github.com/acme/reused", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(t.Context(), `INSERT INTO project_github(project_id,repository_id,repository_full_name,repository_private) VALUES($1,30,'acme/reused',false)`, reused.ID); err != nil {
		t.Fatal(err)
	}
	taskID, claimID, workerID, worktreeID, machineID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err = db.Pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Executing','in_progress')`, taskID, reused.ID); err != nil {
		t.Fatal(err)
	}
	claim, err := json.Marshal(model.WorkerClaim{ClaimID: claimID, State: model.WorkerActive, UserID: actor.UserID, WorkerID: workerID, Machine: model.WorkerMachine{ID: machineID, Name: "Machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: worktreeID, Phase: model.WorkerExecuting, ClaimedAt: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, taskID, claim); err != nil {
		t.Fatal(err)
	}
	var beforeClaim string
	if err = db.Pool.QueryRow(t.Context(), `SELECT value::text FROM task_properties WHERE task_id=$1 AND name='worker'`, taskID).Scan(&beforeClaim); err != nil {
		t.Fatal(err)
	}
	observer := &repositoryObserver{target: 31}
	app.SetRepositoryObserver(observer)
	path = "/api/v1/projects/" + reused.ID + "/repository"
	switchPreview := preview("git@github.com:acme/reused.git")
	if switchPreview.Classification != "different_repository" || switchPreview.TargetGitHubRepositoryID == nil || *switchPreview.TargetGitHubRepositoryID != "31" || !switchPreview.BindingsInvalidated {
		t.Fatalf("same path, different ID: %+v", switchPreview)
	}
	observer.target = 32
	assertCode(call("PATCH", path, "admin", input(switchPreview, false), 409), "version_conflict")
	observer.target = 31
	// Hold a real new claim before its transaction commits. The repository write
	// must wait on the same Project lock, then proceed with that claim active.
	concurrentTask, concurrentClaim := uuid.NewString(), uuid.NewString()
	if _, err = db.Pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,title,status,assigned_to,allow_agents) VALUES($1,$2,'Concurrent claim','todo',$3,true)`, concurrentTask, reused.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	barrier := &claimBarrierStore{Store: db, prepared: make(chan error, 1), release: make(chan struct{})}
	claimDone := make(chan error, 1)
	go func() {
		_, e := taskservice.NewTasks(barrier).ClaimWorker(ctx, actor, reused.ID, concurrentTask, taskcore.ClaimWorker{Version: 1, WorkerDescriptor: taskcore.WorkerDescriptor{ClaimID: concurrentClaim, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}})
		claimDone <- e
	}()
	select {
	case e := <-barrier.prepared:
		if e != nil {
			t.Fatalf("claim preparation: %v", e)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	requestBody, err := json.Marshal(input(switchPreview, false))
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, "PATCH", server.URL+path, bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "daynight_session", Value: "admin"})
	type switchResult struct {
		status int
		body   []byte
		err    error
	}
	switchDone := make(chan switchResult, 1)
	go func() {
		res, e := client.Do(req)
		if e != nil {
			switchDone <- switchResult{err: e}
			return
		}
		defer res.Body.Close()
		raw, e := io.ReadAll(res.Body)
		switchDone <- switchResult{status: res.StatusCode, body: raw, err: e}
	}()
	testutil.WaitForQueryLock(t, db.Pool, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`)
	close(barrier.release)
	select {
	case e := <-claimDone:
		if e != nil {
			t.Fatalf("claim commit: %v", e)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case result := <-switchDone:
		if result.err != nil || result.status != 200 {
			t.Fatalf("switch: status=%d body=%s err=%v", result.status, result.body, result.err)
		}
		err = json.Unmarshal(result.body, &receipt)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err != nil || !receipt.Changed || !receipt.BindingsInvalidated {
		t.Fatalf("different save: %+v %v", receipt, err)
	}
	var concurrentStatus, actualClaim string
	if err = db.Pool.QueryRow(t.Context(), `SELECT t.status,p.value::jsonb->>'claimId' FROM tasks t JOIN task_properties p ON p.task_id=t.id AND p.name='worker' WHERE t.id=$1`, concurrentTask).Scan(&concurrentStatus, &actualClaim); err != nil || concurrentStatus != "in_progress" || actualClaim != concurrentClaim {
		t.Fatalf("concurrent claim: status=%s claim=%s err=%v", concurrentStatus, actualClaim, err)
	}
	var targetID int64
	var fullName string
	var targetPrivate, enabled, syncEnabled bool
	if err = db.Pool.QueryRow(t.Context(), `SELECT repository_id,repository_full_name,repository_private,enabled,sync_enabled FROM project_github WHERE project_id=$1`, reused.ID).Scan(&targetID, &fullName, &targetPrivate, &enabled, &syncEnabled); err != nil || targetID != 31 || fullName != "acme/reused" || !targetPrivate || enabled || syncEnabled {
		t.Fatalf("target identity: %d %q %v %v %v %v", targetID, fullName, targetPrivate, enabled, syncEnabled, err)
	}
	var afterClaim, taskStatus string
	if err = db.Pool.QueryRow(t.Context(), `SELECT p.value::text,t.status FROM task_properties p JOIN tasks t ON t.id=p.task_id WHERE p.task_id=$1 AND p.name='worker'`, taskID).Scan(&afterClaim, &taskStatus); err != nil || afterClaim != beforeClaim || taskStatus != "in_progress" {
		t.Fatalf("active claim changed: %s %s %v", afterClaim, taskStatus, err)
	}
}
