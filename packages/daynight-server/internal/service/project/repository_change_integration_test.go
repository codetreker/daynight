package project

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func repositoryChangeFixture(t *testing.T) (*AppProjects, *postgres.Store, model.Principal, model.Project) {
	t.Helper()
	_, db, _, actor := projectService(t)
	s := NewAppProjects(db)
	p, err := s.Create(t.Context(), actor, core.CreateProject{Name: "Repository", RepoURL: "https://github.com/acme/repo", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	return s, db, actor, p
}

func repositoryChangeInput(p core.RepositoryPreview, actor model.Principal) core.RepositoryChange {
	return core.RepositoryChange{RepoURL: p.RepoURL, ExpectedUserID: actor.UserID, RepositoryVersion: p.RepositoryVersion, OwnershipVersion: p.OwnershipVersion, Classification: p.Classification, TargetGitHubRepositoryID: p.TargetGitHubRepositoryID}
}

func repositoryWorker(t *testing.T, db *postgres.Store, user, id, project, other string, revision int64) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"future": map[string]any{"flag": true}, "projects": []any{map[string]any{"projectId": project, "nativeOverrides": map[string]any{}, "future": "keep only if selected"}, map[string]any{"projectId": other, "future": "retained"}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(t.Context(), `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration,configuration_observation_revision,configuration_observation,archive_sessions) VALUES($1,$2,now(),now()-interval '2 days','{}','{}',$3,now(),$4,7,'{"future":"observation"}',false)`, user, id, revision, raw)
	if err != nil {
		t.Fatal(err)
	}
}

func repositoryState(t *testing.T, db *postgres.Store, p string) string {
	t.Helper()
	var state string
	err := db.Pool.QueryRow(t.Context(), `SELECT jsonb_build_object('project',(SELECT to_jsonb(p) FROM projects p WHERE id=$1),'github',(SELECT to_jsonb(g) FROM project_github g WHERE project_id=$1),'workers',(SELECT jsonb_agg(to_jsonb(w) ORDER BY user_id,worker_id) FROM workers w))::text`, p).Scan(&state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func TestRepositoryChangeTransactionAndConflicts(t *testing.T) {
	s, db, actor, p := repositoryChangeFixture(t)
	ctx := t.Context()
	other := uuid.NewString()
	workerA, workerB := uuid.NewString(), uuid.NewString()
	repositoryWorker(t, db, actor.UserID, workerA, p.ID, other, 4)
	if _, err := db.Pool.Exec(ctx, `UPDATE workers SET last_seen_at=now() WHERE user_id=$1 AND worker_id=$2`, actor.UserID, workerA); err != nil {
		t.Fatal(err)
	}
	second := servicePrincipal(t, db)
	repositoryWorker(t, db, second.UserID, workerB, p.ID, other, 9)
	before := repositoryState(t, db, p.ID)
	unchanged, err := s.RepositoryPreview(ctx, actor, p.ID, p.RepoURL, actor.UserID)
	if err != nil || unchanged.Classification != "unchanged" {
		t.Fatalf("unchanged preview: %+v %v", unchanged, err)
	}
	receipt, err := s.SetRepository(ctx, actor, p.ID, repositoryChangeInput(unchanged, actor))
	if err != nil || receipt.Changed || receipt.RepositoryVersion != 1 || repositoryState(t, db, p.ID) != before {
		t.Fatalf("unchanged: %+v %v", receipt, err)
	}
	same, err := s.RepositoryPreview(ctx, actor, p.ID, "git@github.com:acme/repo.git", actor.UserID)
	if err != nil || same.Classification != "same_repository" {
		t.Fatalf("same preview: %+v %v", same, err)
	}
	receipt, err = s.SetRepository(ctx, actor, p.ID, repositoryChangeInput(same, actor))
	if err != nil || !receipt.Changed || receipt.BindingsInvalidated || receipt.RepositoryVersion != 2 {
		t.Fatalf("same save: %+v %v", receipt, err)
	}
	stale := repositoryChangeInput(same, actor)
	_, err = s.SetRepository(ctx, actor, p.ID, stale)
	transferFault(t, err, "version_conflict")
	var workerRows int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM workers WHERE configuration_revision IN (4,9) AND desired_configuration->'projects' @> jsonb_build_array(jsonb_build_object('projectId',$1::text))`, p.ID).Scan(&workerRows); err != nil || workerRows != 2 {
		t.Fatalf("same repository changed Worker selections: %d %v", workerRows, err)
	}
	occupied, err := s.Create(ctx, actor, core.CreateProject{Name: "Occupied", RepoURL: "https://example.com/occupied", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	conflict, err := s.RepositoryPreview(ctx, actor, p.ID, occupied.RepoURL, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	conflictInput := repositoryChangeInput(conflict, actor)
	conflictInput.TreatUnverifiedAsSwitch = true
	before = repositoryState(t, db, p.ID)
	_, err = s.SetRepository(ctx, actor, p.ID, conflictInput)
	transferFault(t, err, "project_repository_conflict")
	if after := repositoryState(t, db, p.ID); after != before {
		t.Fatal("occupied target changed state")
	}
	preview, err := s.RepositoryPreview(ctx, actor, p.ID, "https://example.com/new", actor.UserID)
	if err != nil || preview.Classification != "unverified" || !preview.BindingsInvalidated {
		t.Fatalf("unknown preview: %+v %v", preview, err)
	}
	input := repositoryChangeInput(preview, actor)
	_, err = s.SetRepository(ctx, actor, p.ID, input)
	transferFault(t, err, "invalid_input")
	if after := repositoryState(t, db, p.ID); after != before {
		t.Fatal("unconfirmed switch changed state")
	}
	input.TreatUnverifiedAsSwitch = true
	receipt, err = s.SetRepository(ctx, actor, p.ID, input)
	if err != nil || !receipt.Changed || !receipt.BindingsInvalidated || receipt.RepositoryVersion != 3 {
		t.Fatalf("switch: %+v %v", receipt, err)
	}
	rows, err := db.Pool.Query(ctx, `SELECT configuration_revision,configuration_observation_revision,configuration_observation,archive_sessions,desired_configuration FROM workers ORDER BY configuration_revision`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var revisions []int64
	for rows.Next() {
		var revision, observed int64
		var observation, raw []byte
		var archive bool
		if err := rows.Scan(&revision, &observed, &observation, &archive, &raw); err != nil {
			t.Fatal(err)
		}
		var config map[string]any
		if err := json.Unmarshal(raw, &config); err != nil {
			t.Fatal(err)
		}
		projects := config["projects"].([]any)
		if observed != 7 || archive || string(observation) != `{"future": "observation"}` || len(projects) != 1 || projects[0].(map[string]any)["projectId"] != other || projects[0].(map[string]any)["future"] != "retained" || !reflect.DeepEqual(config["future"], map[string]any{"flag": true}) {
			t.Fatalf("Worker target not preserved: revision=%d observation=%s config=%v", revision, observation, config)
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(revisions, []int64{5, 10}) {
		t.Fatalf("revisions: %v", revisions)
	}
}

func TestRepositoryChangeWorkerFailureRollsBackProjectAndConnection(t *testing.T) {
	s, db, actor, p := repositoryChangeFixture(t)
	ctx := t.Context()
	repositoryWorker(t, db, actor.UserID, uuid.NewString(), p.ID, uuid.NewString(), math.MaxInt64)
	preview, err := s.RepositoryPreview(ctx, actor, p.ID, "https://example.com/new", actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	before := repositoryState(t, db, p.ID)
	input := repositoryChangeInput(preview, actor)
	input.TreatUnverifiedAsSwitch = true
	_, err = s.SetRepository(ctx, actor, p.ID, input)
	transferFault(t, err, "version_exhausted")
	if after := repositoryState(t, db, p.ID); after != before {
		t.Fatal("failed Worker update left partial Project or GitHub state")
	}
}
