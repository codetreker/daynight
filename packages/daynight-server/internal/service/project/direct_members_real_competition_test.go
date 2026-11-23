package project

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

// The operation runs to completion inside the real transaction before commit is released.
type realCompetitionGate struct {
	*postgres.Store
	reached, release chan struct{}
}

func (g *realCompetitionGate) hold(ctx context.Context) error {
	close(g.reached)
	select {
	case <-g.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *realCompetitionGate) WriteTeam(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
	return g.Store.WriteTeam(ctx, id, func(scope store.TeamWriteScope) error {
		if err := op(scope); err != nil {
			return err
		}
		return g.hold(ctx)
	})
}

func (g *realCompetitionGate) WriteGitHubProjectTransfer(ctx context.Context, id string, op func(store.GitHubProjectTransferScope) error) (store.Completion, error) {
	return g.Store.WriteGitHubProjectTransfer(ctx, id, func(scope store.GitHubProjectTransferScope) error {
		if err := op(scope); err != nil {
			return err
		}
		return g.hold(ctx)
	})
}

func (g *realCompetitionGate) WriteProjectDirectMember(ctx context.Context, id string, op func(store.ProjectDirectMemberScope) error) (store.Completion, error) {
	return g.Store.WriteProjectDirectMember(ctx, id, func(scope store.ProjectDirectMemberScope) error {
		if err := op(scope); err != nil {
			return err
		}
		return g.hold(ctx)
	})
}

func TestRealTeamAndProjectDirectMemberCompetition(t *testing.T) {
	for _, teamFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "team_first", false: "project_first"}[teamFirst], func(t *testing.T) {
			f := newMembershipFixture(t)
			owner, target := f.user(t), f.user(t)
			team := newTestTeam(t, teamservice.NewTeams(f.database), owner, "Real team contention")
			project, err := f.projects.Create(t.Context(), owner, core.CreateProject{ExpectedUserID: owner.UserID, Name: "Real team contention", RepoURL: "https://example.test/" + uuid.NewString(), TeamID: &team.ID})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			gate := &realCompetitionGate{Store: f.database, reached: make(chan struct{}), release: make(chan struct{})}
			var workers sync.WaitGroup
			defer func() {
				select {
				case <-gate.release:
				default:
					close(gate.release)
				}
				cancel()
				workers.Wait()
			}()
			type directResult struct {
				value core.ExistingMemberResult
				err   error
			}
			type teamResult struct {
				value coreteam.ExistingMemberResult
				err   error
			}
			directDone, teamDone := make(chan directResult, 1), make(chan teamResult, 1)
			runDirect := func(writer store.ProjectDirectMemberWriter) {
				defer workers.Done()
				v, e := NewDirectMembers(writer, directCredentialResource).AddExistingMember(ctx, owner, project.ID, target.UserID, owner.UserID)
				directDone <- directResult{v, e}
			}
			runTeam := func(writer store.TeamWriter) {
				defer workers.Done()
				v, e := teamservice.NewDirectMembers(writer, nil, directCredentialResource).AddExistingMember(ctx, owner, team.ID, target.UserID, owner.UserID)
				teamDone <- teamResult{v, e}
			}
			workers.Add(1)
			if teamFirst {
				go runTeam(gate)
			} else {
				go runDirect(gate)
			}
			select {
			case <-gate.reached:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			workers.Add(1)
			if teamFirst {
				go runDirect(f.database)
				waitDirectLock(t, ctx, f.database, "SELECT id::text FROM teams WHERE id=% FOR SHARE%")
			} else {
				go runTeam(f.database)
				waitDirectLock(t, ctx, f.database, "SELECT id::text FROM teams WHERE id=% FOR UPDATE%")
			}
			close(gate.release)
			direct, joined := <-directDone, <-teamDone
			if direct.err != nil || joined.err != nil || !joined.value.Added || direct.value.Added == teamFirst {
				t.Fatalf("direct=%+v %v team=%+v %v", direct.value, direct.err, joined.value, joined.err)
			}
			read, err := NewDirectMembers(f.database, directCredentialResource).AddExistingMember(ctx, owner, project.ID, target.UserID, owner.UserID)
			if err != nil || read.Added || read.Participant.InheritedFrom == nil || (read.Participant.DirectGrant != nil) == teamFirst || read.Participant.EffectiveRole != model.ProjectMemberRole {
				t.Fatalf("persisted %+v %v", read, err)
			}
			members, err := teamservice.NewTeams(f.database).Members(ctx, owner, team.ID)
			if err != nil || len(members) != 2 {
				t.Fatalf("team members=%+v %v", members, err)
			}
		})
	}
}

func TestRealTransferAndProjectDirectMemberCompetition(t *testing.T) {
	for _, transferFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "transfer_first", false: "project_first"}[transferFirst], func(t *testing.T) {
			f := newMembershipFixture(t)
			owner, destinationOwner, target := f.user(t), f.user(t), f.user(t)
			project := f.project(t, owner, "Real transfer contention")
			destination := newTestTeam(t, teamservice.NewTeams(f.database), destinationOwner, "Destination")
			if _, err := f.database.Pool.Exec(t.Context(), `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, owner.UserID); err != nil {
				t.Fatal(err)
			}
			preview, err := f.projects.TransferPreview(t.Context(), owner, project.ID, destination.ID)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			gate := &realCompetitionGate{Store: f.database, reached: make(chan struct{}), release: make(chan struct{})}
			var workers sync.WaitGroup
			defer func() {
				select {
				case <-gate.release:
				default:
					close(gate.release)
				}
				cancel()
				workers.Wait()
			}()
			type directResult struct {
				value core.ExistingMemberResult
				err   error
			}
			type transferResult struct {
				value core.TransferReceipt
				err   error
			}
			directDone, transferDone := make(chan directResult, 1), make(chan transferResult, 1)
			runDirect := func(writer store.ProjectDirectMemberWriter) {
				defer workers.Done()
				v, e := NewDirectMembers(writer, directCredentialResource).AddExistingMember(ctx, owner, project.ID, target.UserID, owner.UserID)
				directDone <- directResult{v, e}
			}
			runTransfer := func(db *realCompetitionGate) {
				defer workers.Done()
				v, e := NewAppProjects(db).Transfer(ctx, owner, project.ID, transferInput(preview, owner))
				transferDone <- transferResult{v, e}
			}
			workers.Add(1)
			if transferFirst {
				go runTransfer(gate)
			} else {
				go runDirect(gate)
			}
			select {
			case <-gate.reached:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			workers.Add(1)
			if transferFirst {
				go runDirect(f.database)
			} else {
				go runTransfer(&realCompetitionGate{Store: f.database, reached: make(chan struct{}), release: closedRealCompetitionGate()})
			}
			waitDirectLock(t, ctx, f.database, "SELECT id::text FROM projects WHERE id=% FOR UPDATE%")
			close(gate.release)
			direct, transfer := <-directDone, <-transferDone
			if transfer.err != nil || !transfer.value.Changed || transfer.value.Ownership.TeamID != destination.ID {
				t.Fatalf("transfer %+v %v", transfer.value, transfer.err)
			}
			if transferFirst {
				var fault *model.Fault
				if !errors.As(direct.err, &fault) || fault.Code != "not_found" {
					t.Fatalf("old owner admitted: %+v %v", direct.value, direct.err)
				}
				assertNoDirectGrant(t, f, project.ID, target.UserID)
			} else if direct.err != nil || !direct.value.Added || direct.value.Participant.DirectGrant == nil {
				t.Fatalf("direct %+v %v", direct.value, direct.err)
			} else {
				got := f.member(t, target, project.ID).Grant
				if got != *direct.value.Participant.DirectGrant {
					t.Fatalf("grant changed across transfer: %+v %+v", got, direct.value.Participant.DirectGrant)
				}
			}
		})
	}
}

func closedRealCompetitionGate() chan struct{} { c := make(chan struct{}); close(c); return c }
