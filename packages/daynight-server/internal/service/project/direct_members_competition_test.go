package project

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

// Pause after the actual Project and Team locks are held.
type competitionWriter struct {
	*postgres.Store
	reached, release chan struct{}
	once             sync.Once
}

func (w *competitionWriter) WriteProjectDirectMember(ctx context.Context, id string, operation func(store.ProjectDirectMemberScope) error) (store.Completion, error) {
	return w.Store.WriteProjectDirectMember(ctx, id, func(scope store.ProjectDirectMemberScope) error {
		w.once.Do(func() { close(w.reached); <-w.release })
		return operation(scope)
	})
}

func TestDirectMemberWaitsForRevocationAndGrantChange(t *testing.T) {
	for _, mode := range []string{"revoke", "grant"} {
		t.Run(mode, func(t *testing.T) {
			f := newMembershipFixture(t)
			owner, actor, target := f.user(t), f.user(t), f.user(t)
			project := f.project(t, owner, "Queued direct member")
			actorGrant := f.join(t, owner, actor, project.ID).Grant
			if _, err := f.memberships.SetRole(context.Background(), owner, project.ID, actor.UserID, core.SetProjectMemberRole{Version: actorGrant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID}); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			type outcome struct {
				value core.ExistingMemberResult
				err   error
			}
			result := make(chan outcome, 1)
			var grant model.ProjectGrant
			if err := writeProjectForTest(f.database, ctx, project.ID, func(scope store.ProjectWriteScope) error {
				var err error
				if mode == "revoke" {
					err = scope.ProjectDAO().RemoveMember(ctx, actor.UserID)
				} else {
					grant, err = scope.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectAdmin)
				}
				if err != nil {
					return err
				}
				go func() {
					v, e := NewDirectMembers(f.database, "https://example.test/api/v1").AddExistingMember(ctx, actor, project.ID, target.UserID, actor.UserID)
					result <- outcome{v, e}
				}()
				waitDirectLock(t, ctx, f.database, "SELECT id::text FROM projects WHERE id=%")
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			got := <-result
			if mode == "revoke" {
				var fault *model.Fault
				if !errors.As(got.err, &fault) || fault.Code != "not_found" {
					t.Fatalf("revocation: %v", got.err)
				}
				var n int
				if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, target.UserID).Scan(&n); err != nil || n != 0 {
					t.Fatalf("target grant count %d: %v", n, err)
				}
			} else if got.err != nil || got.value.Added || !reflect.DeepEqual(got.value.Participant.DirectGrant, &grant) || got.value.Participant.EffectiveRole != model.ProjectAdmin {
				t.Fatalf("grant after waiting: %+v %v", got.value, got.err)
			}
		})
	}
}

func TestDirectMemberCompetesWithInvitation(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	project := f.project(t, owner, "Direct and invitation")
	invitation := f.invite(t, owner, project.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	w := &competitionWriter{Store: f.database, reached: make(chan struct{}), release: make(chan struct{})}
	defer func() {
		select {
		case <-w.release:
		default:
			close(w.release)
		}
	}()
	type directResult struct {
		value core.ExistingMemberResult
		err   error
	}
	type invitationResult struct {
		value core.InvitationAcceptance
		err   error
	}
	directDone, inviteDone := make(chan directResult, 1), make(chan invitationResult, 1)
	go func() {
		v, e := NewDirectMembers(w, "https://example.test/api/v1").AddExistingMember(ctx, owner, project.ID, target.UserID, owner.UserID)
		directDone <- directResult{v, e}
	}()
	<-w.reached
	go func() {
		v, e := f.memberships.AcceptInvitation(ctx, target, invitation.Secret, target.UserID)
		inviteDone <- invitationResult{v, e}
	}()
	waitForTaskWriters(t, ctx, f.database, 1)
	close(w.release)
	direct, accepted := <-directDone, <-inviteDone
	if direct.err != nil || !direct.value.Added || direct.value.Participant.DirectGrant == nil || accepted.err != nil || accepted.value.Joined || accepted.value.Consumed || !reflect.DeepEqual(accepted.value.DirectGrant, *direct.value.Participant.DirectGrant) {
		t.Fatalf("direct %+v %v; invitation %+v %v", direct.value, direct.err, accepted.value, accepted.err)
	}
}

func TestDirectMemberWaitsForOwnershipChange(t *testing.T) {
	f := newMembershipFixture(t)
	owner, newOwner, target := f.user(t), f.user(t), f.user(t)
	project := f.project(t, owner, "Transfer before direct")
	team := newTestTeam(t, teamservice.NewTeams(f.database), newOwner, "New owner")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := f.database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, project.ID, team.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, owner.UserID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := NewDirectMembers(f.database, "https://example.test/api/v1").AddExistingMember(ctx, owner, project.ID, target.UserID, owner.UserID)
		done <- err
	}()
	waitDirectLock(t, ctx, f.database, "SELECT id::text FROM projects WHERE id=%")
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var fault *model.Fault
	if err = <-done; !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("ownership change: %v", err)
	}
	var n int
	if err = f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, target.UserID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("target grant count %d: %v", n, err)
	}
}
