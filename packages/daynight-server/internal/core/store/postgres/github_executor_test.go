package postgres

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	syncgithub "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	"github.com/google/uuid"
)

// controlledGitHub invokes the production request checkpoint at each simulated
// network boundary. The signal hook runs during the fetch, outside any DB scope.
type controlledGitHub struct {
	page       []githubpr.Observation
	pulls      map[int64]githubpr.Observation
	duringPull func(context.Context, int64) error
}

func (r *controlledGitHub) Installation(ctx context.Context, id int64) (remote.InstallationStatus, error) {
	if err := remote.CheckpointRequest(ctx); err != nil {
		return remote.InstallationStatus{}, err
	}
	return remote.InstallationStatus{ID: id}, nil
}
func (r *controlledGitHub) VerifyAccess(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
	if err := remote.CheckpointRequest(ctx); err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	return githubpr.RepositoryObservation{ID: 30, FullName: "owner/repo", Private: true}, nil
}
func (r *controlledGitHub) ResolveRepository(ctx context.Context, _, _ int64) (githubpr.RepositoryObservation, error) {
	if err := remote.CheckpointRequest(ctx); err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	return githubpr.RepositoryObservation{ID: 30, FullName: "owner/repo", Private: true}, nil
}
func (r *controlledGitHub) ListOpen(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
	if err := remote.CheckpointRequest(ctx); err != nil {
		return err
	}
	return visit(r.page)
}
func (r *controlledGitHub) PullRequest(ctx context.Context, _ int64, _, _ string, number int64) (githubpr.Observation, error) {
	if err := remote.CheckpointRequest(ctx); err != nil {
		return githubpr.Observation{}, err
	}
	if r.duringPull != nil {
		if err := r.duringPull(ctx, number); err != nil {
			return githubpr.Observation{}, err
		}
	}
	item, ok := r.pulls[number]
	if !ok {
		return githubpr.Observation{}, fmt.Errorf("unexpected pull %d", number)
	}
	return item, nil
}

func executorFact(number int64, state, sha, description string, at time.Time) githubpr.Observation {
	return githubpr.Observation{Number: number, GitHubID: 100 + number, URL: fmt.Sprintf("https://github.com/owner/repo/pull/%d", number), Title: "title", State: state, BaseRepositoryID: 30, BaseRef: "main", HeadSHA: sha, CreatedAt: at, UpdatedAt: at, Description: &description}
}

func TestGitHubExecutorPersistsPollAndConcurrentHint(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	b2Configure(t, db, project.ID, 10, 20, 30)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	mustQueryExec(t, db, `UPDATE project_github SET repository_full_name='owner/repo', installation_account_login='owner', next_poll_at=clock_timestamp() WHERE project_id=$1`, project.ID)
	now := time.Now().UTC().Truncate(time.Microsecond)
	first := executorFact(1, "open", "one", "旧正文", now)
	second := executorFact(2, "open", "two", "second", now)
	upstream := &controlledGitHub{page: []githubpr.Observation{first, second}, pulls: map[int64]githubpr.Observation{}}
	executor, err := syncgithub.NewExecutor(db, upstream, 10, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("first poll: %v", err)
	}
	var firstSuccess time.Time
	var gen int64
	var claim *string
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at,last_full_generation,claim_token::text,(SELECT count(*) FROM project_pull_requests WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project.ID).Scan(&firstSuccess, &gen, &claim, &count); err != nil || firstSuccess.IsZero() || gen != 1 || claim != nil || count != 2 {
		t.Fatalf("initial: success=%s gen=%d claim=%v count=%d err=%v", firstSuccess, gen, claim, count, err)
	}
	// The second poll sees a same-second head change and individually confirms
	// that the missing previously active PR closed.
	first.HeadSHA = "changed-same-second"
	first.Description = pointerString("新正文")
	second.State = "closed"
	second.ClosedAt = &now
	upstream.page = []githubpr.Observation{first}
	upstream.pulls[2] = second
	mustQueryExec(t, db, `UPDATE project_github SET next_poll_at=clock_timestamp() WHERE project_id=$1`, project.ID)
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("second poll: %v", err)
	}
	var sha, body, state string
	if err = db.Pool.QueryRow(ctx, `SELECT head_sha,description FROM project_pull_requests WHERE project_id=$1 AND number=1`, project.ID).Scan(&sha, &body); err != nil || sha != "changed-same-second" || body != "新正文" {
		t.Fatalf("open fact: %s %s %v", sha, body, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT state FROM project_pull_requests WHERE project_id=$1 AND number=2`, project.ID).Scan(&state); err != nil || state != "closed" {
		t.Fatalf("absent fact: %s %v", state, err)
	}
	var nextSuccess time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at FROM project_github WHERE project_id=$1`, project.ID).Scan(&nextSuccess); err != nil || nextSuccess.Before(firstSuccess) {
		t.Fatalf("complete poll: %s %v", nextSuccess, err)
	}

	// Reopening the same PR restores the retained row to the active set.
	second.State, second.ClosedAt, second.HeadSHA = "open", nil, "reopened-head"
	second.Description = pointerString("reopened body")
	upstream.page = []githubpr.Observation{first, second}
	mustQueryExec(t, db, `UPDATE project_github SET next_poll_at=clock_timestamp() WHERE project_id=$1`, project.ID)
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("reopen poll: %v", err)
	}
	var githubID int64
	var closedAt *time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT state,github_id,head_sha,description,github_closed_at FROM project_pull_requests WHERE project_id=$1 AND number=2`, project.ID).Scan(&state, &githubID, &sha, &body, &closedAt); err != nil || state != "open" || githubID != second.GitHubID || sha != "reopened-head" || body != "reopened body" || closedAt != nil {
		t.Fatalf("reopened fact: state=%s id=%d head=%s body=%s closed=%v err=%v", state, githubID, sha, body, closedAt, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pull_requests WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("reopen created duplicate records: %d %v", count, err)
	}
	var reopenedSuccess time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at FROM project_github WHERE project_id=$1`, project.ID).Scan(&reopenedSuccess); err != nil || reopenedSuccess.Before(nextSuccess) {
		t.Fatalf("reopen poll completion: %s %v", reopenedSuccess, err)
	}
	nextSuccess = reopenedSuccess

	request1, request2 := uuid.NewString(), uuid.NewString()
	signal := store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 1, RequestID: request1, DeliveryID: "one", ReceivedAt: now, NextAttemptAt: now}
	if got := b2Signal(t, db, signal); got != 1 {
		t.Fatalf("first signal: %d", got)
	}
	first.HeadSHA = "event-first"
	upstream.pulls[1] = first
	upstream.duringPull = func(ctx context.Context, n int64) error {
		if n != 1 {
			return fmt.Errorf("unexpected hint %d", n)
		}
		upstream.duringPull = nil
		signal.RequestID, signal.DeliveryID = request2, "two"
		completion, err := db.WriteGitHubSignals(ctx, func(w store.GitHubSignalWriter) error { _, err := w.SignalPullRequest(ctx, signal); return err })
		if err != nil || completion.Outcome != store.TransactionCommitted {
			return fmt.Errorf("replace signal: %+v %w", completion, err)
		}
		return nil
	}
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("first hint: %v", err)
	}
	var pending string
	if err = db.Pool.QueryRow(ctx, `SELECT request_id::text FROM project_github_pending_prs WHERE project_id=$1 AND number=1`, project.ID).Scan(&pending); err != nil || pending != request2 {
		t.Fatalf("new hint lost: %s %v", pending, err)
	}
	first.HeadSHA = "event-second"
	upstream.pulls[1] = first
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("second hint: %v", err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=1`, project.ID).Scan(&sha); err != nil || sha != "event-second" {
		t.Fatalf("second hint: %s %v", sha, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("hint acknowledgement: %d %v", count, err)
	}
	var afterHints time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at FROM project_github WHERE project_id=$1`, project.ID).Scan(&afterHints); err != nil || !afterHints.Equal(nextSuccess) {
		t.Fatalf("hints changed poll success: %s %v", afterHints, err)
	}
}
func pointerString(v string) *string { return &v }
