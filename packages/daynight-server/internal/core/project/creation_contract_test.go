package project

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const contractActor = "a1111111-1111-4111-8111-111111111111"
const contractCredential = "b2222222-2222-4222-8222-222222222222"
const contractPersonalTeam = "d0000000-0000-4000-8000-000000000050"

func contractPrincipal() model.Principal {
	return model.Principal{UserID: contractActor, CredentialID: contractCredential, Kind: model.PATCredential}
}
func contractProject(id, name, repo, team string) model.Project {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Project{ID: id, Name: name, RepoURL: repo, CreatedAt: at, UpdatedAt: at, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}, Ownership: model.ProjectOwnership{TeamID: team, Version: 1, UpdatedAt: at}}
}
func contractAccess(p model.Principal, v model.Project) model.ProjectAccess {
	role := model.ProjectAdmin
	grant := model.ProjectGrant{ProjectID: v.ID, UserID: p.UserID, Role: role, Version: 1, CreatedAt: v.CreatedAt, UpdatedAt: v.CreatedAt}
	return model.ProjectAccess{ProjectID: v.ID, UserID: p.UserID, Role: role, DirectGrant: &grant, OwnerTeam: model.TeamRef{ID: v.Ownership.TeamID, Kind: "personal"}, Ownership: v.Ownership, TeamRole: &role, CanTransfer: true}
}
func contractClonePointer[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
func contractCloneAccess(v model.ProjectAccess) model.ProjectAccess {
	v.DirectGrant = contractClonePointer(v.DirectGrant)
	v.OwnerTeam.Name = contractClonePointer(v.OwnerTeam.Name)
	v.TeamRole = contractClonePointer(v.TeamRole)
	return v
}
func contractEqual(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}
func contractPlan(t *testing.T, ctx context.Context, want ...string) func(context.Context, string) {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != len(want) {
			t.Errorf("calls=%d, want %v", calls, want)
		}
	})
	return func(got context.Context, name string) {
		t.Helper()
		if got != ctx || calls >= len(want) || want[calls] != name {
			t.Fatalf("unexpected %s context=%v at %d, want %v", name, got, calls, want)
		}
		calls++
	}
}

type creationContractDAO struct {
	personal func(context.Context, bool) (store.PersonalTeamFacts, error)
	team     func(context.Context, string) (store.ProjectCreationTeam, error)
	member   func(context.Context, string) (bool, error)
	insert   func(context.Context, string, string, string, string) (model.Project, model.ProjectAccess, error)
}

func (d creationContractDAO) CreationPersonalTeam(ctx context.Context, lock bool) (store.PersonalTeamFacts, error) {
	return d.personal(ctx, lock)
}
func (d creationContractDAO) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	return d.team(ctx, id)
}
func (d creationContractDAO) CreationTeamMember(ctx context.Context, id string) (bool, error) {
	return d.member(ctx, id)
}
func (d creationContractDAO) InsertProject(ctx context.Context, id, name, repo, team string) (model.Project, model.ProjectAccess, error) {
	return d.insert(ctx, id, name, repo, team)
}

func TestProjectCreationPreservesExactInputsAndReturnedModels(t *testing.T) {
	p := contractPrincipal()
	for _, tc := range []struct {
		name, repo, team string
		explicit         bool
	}{
		{"API work", "git@github.com:example/repository.git", contractPersonalTeam, false},
		{" 原文 ", "git@example.com:Org/Repo.git", "00000000-0000-4000-8000-000000000090", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			id := "f0000000-0000-4000-8000-000000000000"
			expectedTeam := tc.team
			input := CreateProject{Name: tc.name, RepoURL: tc.repo, ExpectedUserID: p.UserID}
			want := contractProject(id, tc.name, tc.repo, expectedTeam)
			wantAccess := contractAccess(p, want)
			dao := creationContractDAO{}
			var take func(context.Context, string)
			if tc.explicit {
				inputTeamID := expectedTeam
				input.TeamID = &inputTeamID
				name := "Team"
				wantAccess.OwnerTeam = model.TeamRef{ID: expectedTeam, Kind: "ordinary", Name: &name}
				take = contractPlan(t, ctx, "lock", "member", "insert")
				dao.team = func(c context.Context, id string) (store.ProjectCreationTeam, error) {
					take(c, "lock")
					contractEqual(t, id, expectedTeam)
					return store.ProjectCreationTeam{ID: expectedTeam}, nil
				}
				dao.member = func(c context.Context, id string) (bool, error) {
					take(c, "member")
					contractEqual(t, id, expectedTeam)
					return true, nil
				}
			} else {
				take = contractPlan(t, ctx, "personal", "insert")
				dao.personal = func(c context.Context, lock bool) (store.PersonalTeamFacts, error) {
					take(c, "personal")
					contractEqual(t, lock, true)
					return store.PersonalTeamFacts{ID: expectedTeam, MemberCount: 1, OwnerAdminCount: 1}, nil
				}
			}
			dao.insert = func(c context.Context, gotID, name, repo, team string) (model.Project, model.ProjectAccess, error) {
				take(c, "insert")
				contractEqual(t, []string{gotID, name, repo, team}, []string{id, tc.name, tc.repo, expectedTeam})
				return want, contractCloneAccess(wantAccess), nil
			}
			snapshot := input
			snapshot.TeamID = contractClonePointer(input.TeamID)
			err := ValidateCreate(p, input)
			contractEqual(t, input, snapshot)
			if err != nil {
				t.Fatal(err)
			}
			got, access, err := Create(ctx, dao, p.UserID, id, input)
			contractEqual(t, input, snapshot)
			if err != nil {
				t.Fatal(err)
			}
			contractEqual(t, got, want)
			contractEqual(t, access, wantAccess)
		})
	}
}

func TestProjectCreationValidationKeepsOriginalRefusals(t *testing.T) {
	p := contractPrincipal()
	for _, tc := range []struct {
		name  string
		input CreateProject
		code  string
	}{
		{"blank name", CreateProject{Name: " ", RepoURL: "https://github.com/example/repo", ExpectedUserID: p.UserID}, "invalid_input"},
		{"NUL name", CreateProject{Name: "\x00", RepoURL: "https://github.com/example/repo", ExpectedUserID: p.UserID}, "invalid_input"},
		{"repository credentials", CreateProject{Name: "ok", RepoURL: "https://user:password-secret@github.com/example/repo", ExpectedUserID: p.UserID}, "invalid_input"},
		{"repository syntax", CreateProject{Name: "ok", RepoURL: "not-a-repository", ExpectedUserID: p.UserID}, "invalid_input"},
		{"changed account", CreateProject{Name: " 原文 ", RepoURL: "git@example.com:Org/Repo.git", ExpectedUserID: "00000000-0000-4000-8000-000000000001"}, "identity_mismatch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := tc.input
			team := "00000000-0000-4000-8000-000000000090"
			if tc.code == "identity_mismatch" {
				input.TeamID = &team
			}
			snapshot := input
			snapshot.TeamID = contractClonePointer(input.TeamID)
			err := ValidateCreate(p, input)
			contractEqual(t, input, snapshot)
			faultCode(t, err, tc.code)
		})
	}
	t.Run("missing Team", func(t *testing.T) {
		ctx := t.Context()
		const expectedTeam = "00000000-0000-4000-8000-000000000002"
		inputTeamID := expectedTeam
		input := CreateProject{Name: " 原文 ", RepoURL: "git@example.com:Org/Repo.git", TeamID: &inputTeamID, ExpectedUserID: p.UserID}
		snapshot := input
		snapshot.TeamID = contractClonePointer(input.TeamID)
		err := ValidateCreate(p, input)
		contractEqual(t, input, snapshot)
		if err != nil {
			t.Fatal(err)
		}
		take := contractPlan(t, ctx, "lock")
		dao := creationContractDAO{team: func(c context.Context, id string) (store.ProjectCreationTeam, error) {
			take(c, "lock")
			contractEqual(t, id, expectedTeam)
			return store.ProjectCreationTeam{}, model.ErrNotFound
		}, insert: func(context.Context, string, string, string, string) (model.Project, model.ProjectAccess, error) {
			t.Fatal("missing Team reached InsertProject")
			return model.Project{}, model.ProjectAccess{}, nil
		}}
		value, access, err := Create(ctx, dao, p.UserID, "f0000000-0000-4000-8000-000000000000", input)
		contractEqual(t, input, snapshot)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Team error=%v", err)
		}
		contractEqual(t, value, model.Project{})
		contractEqual(t, access, model.ProjectAccess{})
	})

}
