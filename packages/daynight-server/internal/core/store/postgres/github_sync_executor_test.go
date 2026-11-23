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
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGitHubExecutorsStopOldObservationAcrossInstances(t *testing.T) {
	db := isolatedStore(t)
	project, other := queryProject(t, db, 1), queryProject(t, db, 2)
	b2Configure(t, db, project.ID, 10, 20, 30)
	b2Configure(t, db, other.ID, 10, 20, 30)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	mustQueryExec(t, db, `UPDATE project_github SET repository_full_name='owner/repo',installation_account_login='owner',next_poll_at=clock_timestamp()`)
	pool, err := pgxpool.NewWithConfig(ctx, db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	secondDB := &Store{Pool: pool}
	now := time.Now().UTC().Truncate(time.Microsecond)
	entered, release := make(chan struct{}), make(chan struct{})
	oldRemote := &controlledGitHub{page: []githubpr.Observation{executorFact(1, "open", "old", "old", now)}, beforeList: func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	nextRemote := &controlledGitHub{page: []githubpr.Observation{executorFact(2, "open", "new", "new", now)}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	first := controlledAppExecutor(t, db, oldRemote, logger)
	second := controlledAppExecutor(t, secondDB, nextRemote, logger)
	done := make(chan error, 1)
	go func() { done <- first.Execute(ctx, project.ID) }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	b2ManageWrite(t, secondDB, project.ID, func(ctx context.Context, dao store.GitHubProjectAppWriteDAO, facts store.GitHubProjectAppFacts) error {
		c := facts.Connection
		ok, err := b2Save(dao, ctx, facts, store.GitHubConfigurationWrite{ExpectedVersion: c.Version, Version: c.Version + 1, Generation: c.Generation + 1, Revision: c.Revision + 1, Enabled: true, SyncEnabled: false, AppID: c.AppID, InstallationID: c.InstallationID, RepositoryID: c.RepositoryID, InstallationAccountLogin: c.InstallationAccountLogin, RepositoryFullName: c.RepositoryFullName, RepositoryPrivate: c.RepositoryPrivate, PollIntervalMinutes: c.PollIntervalMinutes, AccessState: c.AccessState}, false)
		if err != nil || !ok {
			return fmt.Errorf("stop: %t %v", ok, err)
		}
		return nil
	})
	if err := second.Execute(ctx, project.ID); err != nil {
		t.Fatalf("disabled executor: %v", err)
	}
	if err := second.Execute(ctx, other.ID); err != nil {
		t.Fatalf("other executor: %v", err)
	}
	close(release)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("old executor published after stop")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var stopped, otherCount int
	var enabled, syncEnabled bool
	var claim *string
	if err := db.Pool.QueryRow(ctx, `SELECT enabled,sync_enabled,claim_token::text,(SELECT count(*) FROM project_pull_requests WHERE project_id=$1),(SELECT count(*) FROM project_pull_requests WHERE project_id=$2) FROM project_github WHERE project_id=$1`, project.ID, other.ID).Scan(&enabled, &syncEnabled, &claim, &stopped, &otherCount); err != nil || !enabled || syncEnabled || claim != nil || stopped != 0 || otherCount != 1 {
		t.Fatalf("stopped=%d other=%d enabled=%t sync=%t claim=%v error=%v", stopped, otherCount, enabled, syncEnabled, claim, err)
	}
	b2ManageWrite(t, db, project.ID, func(ctx context.Context, dao store.GitHubProjectAppWriteDAO, facts store.GitHubProjectAppFacts) error {
		c := facts.Connection
		ok, err := b2Save(dao, ctx, facts, store.GitHubConfigurationWrite{ExpectedVersion: c.Version, Version: c.Version + 1, Generation: c.Generation + 1, Revision: c.Revision + 1, Enabled: true, SyncEnabled: true, AppID: c.AppID, InstallationID: c.InstallationID, RepositoryID: c.RepositoryID, InstallationAccountLogin: c.InstallationAccountLogin, RepositoryFullName: c.RepositoryFullName, RepositoryPrivate: c.RepositoryPrivate, PollIntervalMinutes: c.PollIntervalMinutes, AccessState: c.AccessState, NextPollAt: &now}, false)
		if err != nil || !ok {
			return fmt.Errorf("restart: %t %v", ok, err)
		}
		return nil
	})
	if err := second.Execute(ctx, project.ID); err != nil {
		t.Fatalf("new generation: %v", err)
	}
	var sha string
	if err := db.Pool.QueryRow(ctx, `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=2`, project.ID).Scan(&sha); err != nil || sha != "new" {
		t.Fatalf("new generation observation: %q %v", sha, err)
	}
}
