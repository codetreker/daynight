package postgres

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProjectWebhookAndGrantRevocationSerialize(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, configureFirst := range []bool{true, false} {
		t.Run(fmt.Sprintf("configureFirst=%t", configureFirst), func(t *testing.T) {
			f := lifecycleFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			entered, release := make(chan struct{}), make(chan struct{})
			first, second := make(chan error, 1), make(chan error, 1)
			var releaseOnce sync.Once
			var workers sync.WaitGroup
			releaseNow := func() { releaseOnce.Do(func() { close(release) }) }
			defer func() { cancel(); releaseNow(); workers.Wait() }()
			start := func(result chan<- error, op func() error) {
				workers.Add(1)
				go func() { defer workers.Done(); result <- op() }()
			}
			hold := func() error {
				close(entered)
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			configure := func(block bool) error {
				repo, secret := int64(10), "project-secret"
				c, err := f.db.WriteProject(ctx, f.project.ID, func(scope store.ProjectWriteScope) error {
					_, err := coregithub.ManageProjectWebhook(ctx, scope.(store.GitHubProjectWebhookScope).GitHubProjectWebhookDAO(), f.actor, coregithub.ProjectWebhookInput{ExpectedUserID: f.actor.UserID, Enabled: true, RepositoryID: &repo, Secret: &secret})
					if err != nil {
						return err
					}
					if block {
						return hold()
					}
					return nil
				})
				if !configureFirst {
					var fault *model.Fault
					if c.Outcome != store.TransactionNotCommitted || !errors.As(err, &fault) || fault.Code != "github_not_connected" {
						return fmt.Errorf("configure after revoke: %+v %v", c, err)
					}
					return nil
				}
				if err != nil || c.Outcome != store.TransactionCommitted {
					return fmt.Errorf("configure before revoke: %+v %w", c, err)
				}
				return nil
			}
			revoke := func(block bool) error {
				c, err := f.db.WriteGitHubGrant(ctx, f.project.Ownership.TeamID, f.app, f.actor.UserID, func(w store.GitHubGrantWriteDAO) error {
					if err := coregithub.RevokeGrant(ctx, w, f.actor, f.grant, coregithub.RevokeGrantInput{ExpectedUserID: f.actor.UserID, Version: 1, ImpactVersion: 1}); err != nil {
						return err
					}
					if block {
						return hold()
					}
					return nil
				})
				if err != nil || c.Outcome != store.TransactionCommitted {
					return fmt.Errorf("revoke: %+v %w", c, err)
				}
				return nil
			}
			if configureFirst {
				start(first, func() error { return configure(true) })
			} else {
				start(first, func() error { return revoke(true) })
			}
			select {
			case <-entered:
			case err := <-first:
				t.Fatalf("first operation did not reach barrier: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if configureFirst {
				start(second, func() error { return revoke(false) })
				waitForQueryLock(t, f.db, "SELECT COALESCE(bool_or(version=")
			} else {
				start(second, func() error { return configure(false) })
				waitForQueryLock(t, f.db, "SELECT hook_version,hook_repository_id,hook_enabled,hook_last_received_at,")
			}
			releaseNow()
			if err := receiveQueryResult(t, ctx, first); err != nil {
				t.Fatal(err)
			}
			if err := receiveQueryResult(t, ctx, second); err != nil {
				t.Fatal(err)
			}
			var revoked, stopped, configured, unconfigured bool
			err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT revoked_at IS NOT NULL FROM github_app_team_grants WHERE id=$2), NOT enabled AND app_resource_id IS NULL AND team_grant_id IS NULL, COALESCE(hook_version=1 AND hook_repository_id=10 AND hook_enabled AND hook_secret='project-secret'::bytea AND hook_last_received_at IS NULL,false), hook_version IS NULL AND hook_repository_id IS NULL AND NOT hook_enabled AND hook_secret IS NULL AND hook_last_received_at IS NULL FROM project_github WHERE project_id=$1`, f.project.ID, f.grant).Scan(&revoked, &stopped, &configured, &unconfigured)
			if err != nil || !revoked || !stopped || configured != configureFirst || unconfigured == configureFirst {
				t.Fatalf("revoked=%t stopped=%t configured=%t unconfigured=%t: %v", revoked, stopped, configured, unconfigured, err)
			}
		})
	}
}
