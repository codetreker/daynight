package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTransferAndTargetTeamDeletionSerialize(t *testing.T) {
	for _, transferFirst := range []bool{false, true} {
		for _, firstCommits := range []bool{false, true} {
			t.Run(fmt.Sprintf("transferFirst=%t/commit=%t", transferFirst, firstCommits), func(t *testing.T) {
				s, actor, _, project := membershipFixture(t)
				target, err := s.CreateTeam(context.Background(), actor.UserID, uuid.NewString(), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				rollback := errors.New("test rollback")
				occupied := errors.New("destination contains projects")
				missing := errors.New("destination is missing")
				ready, release := make(chan uint32, 1), make(chan struct{})
				first, second := make(chan error, 1), make(chan error, 1)
				transfer := func(hold bool) error {
					return s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
						ownership, err := tx.LockTransferOwnership(ctx)
						if err != nil {
							return err
						}
						_, destination, err := tx.LockTransferTeams(ctx, ownership.TeamID, target.ID)
						if err != nil {
							return err
						}
						if destination.Ref.ID == "" {
							return missing
						}
						if _, err := tx.MoveOwnership(ctx, target.ID); err != nil {
							return err
						}
						if hold {
							ready <- tx.tx.Conn().PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
							if !firstCommits {
								return rollback
							}
						}
						return nil
					})
				}
				deleteTeam := func(hold bool) error {
					return s.WriteTeam(ctx, target.ID, func(tx *TeamTx) error {
						found, err := tx.HasProjects(ctx)
						if err != nil {
							return err
						}
						if found {
							return occupied
						}
						if err := tx.Delete(ctx); err != nil {
							return err
						}
						if hold {
							ready <- tx.tx.Conn().PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
							if !firstCommits {
								return rollback
							}
						}
						return nil
					})
				}
				if transferFirst {
					go func() { first <- transfer(true) }()
				} else {
					go func() { first <- deleteTeam(true) }()
				}
				var blockerPID uint32
				select {
				case blockerPID = <-ready:
				case err := <-first:
					t.Fatalf("first operation did not reach barrier: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if transferFirst {
					go func() { second <- deleteTeam(false) }()
					waitTransferTeamLock(t, ctx, s, "SELECT id::text FROM teams WHERE", blockerPID)
				} else {
					go func() { second <- transfer(false) }()
					waitTransferTeamLock(t, ctx, s, "SELECT id::text,name,personal_user_id::text,version FROM teams WHERE", blockerPID)
				}
				close(release)
				err = receiveQueryResult(t, ctx, first)
				if firstCommits && err != nil || !firstCommits && !errors.Is(err, rollback) {
					t.Fatalf("first operation: %v", err)
				}
				err = receiveQueryResult(t, ctx, second)
				if transferFirst && firstCommits {
					if !errors.Is(err, occupied) {
						t.Fatalf("delete missed transferred project: %v", err)
					}
				} else if !transferFirst && firstCommits {
					if !errors.Is(err, missing) {
						t.Fatalf("transfer missed deleted destination: %v", err)
					}
				} else if err != nil {
					t.Fatalf("second operation after rollback: %v", err)
				}
				var owner string
				var teamExists bool
				if err := s.Pool.QueryRow(ctx, `SELECT o.team_id::text,EXISTS(SELECT 1 FROM teams WHERE id=$2)
 FROM project_ownership o WHERE o.project_id=$1`, project.ID, target.ID).Scan(&owner, &teamExists); err != nil {
					t.Fatal(err)
				}
				wantTransfer := transferFirst == firstCommits
				if wantTransfer && (owner != target.ID || !teamExists) || !wantTransfer && (owner != project.Ownership.TeamID || teamExists) {
					t.Fatalf("inconsistent owner or destination: %s exists=%t", owner, teamExists)
				}
			})
		}
	}
}

func waitTransferTeamLock(t *testing.T, ctx context.Context, s *Store, prefix string, blockerPID uint32) {
	t.Helper()
	for {
		var waiting bool
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
 WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid)))`, prefix+"%", blockerPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("operation did not wait for the other Team transaction: %v", err)
		}
	}
}
