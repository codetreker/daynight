package project

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

var errScopedWitness = errors.New("scoped service witness")

type scopedRouteWitness struct {
	method string
	auth   model.CredentialAuthorization
	args   []any
}
type testScopedProjects struct {
	scopedProjects
	w *scopedRouteWitness
}

func (s testScopedProjects) CreateWithAccess(ctx context.Context, a model.CredentialAuthorization, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
	s.w.method = "CreateWithAccess"
	s.w.auth = a
	s.w.args = []any{input}
	return model.Project{}, model.ProjectAccess{}, errScopedWitness
}
func (s testScopedProjects) GetWithAccess(ctx context.Context, a model.CredentialAuthorization, id string) (model.Project, model.ProjectAccess, error) {
	s.w.method = "GetWithAccess"
	s.w.auth = a
	s.w.args = []any{id}
	return model.Project{}, model.ProjectAccess{}, errScopedWitness
}
func (s testScopedProjects) ListScoped(ctx context.Context, a model.CredentialAuthorization, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	s.w.method = "ListScoped"
	s.w.auth = a
	s.w.args = []any{input}
	return coreproject.ProjectPage{}, errScopedWitness
}
func (s testScopedProjects) Access(ctx context.Context, a model.CredentialAuthorization, id string) (model.ProjectAccess, error) {
	s.w.method = "Access"
	s.w.auth = a
	s.w.args = []any{id}
	return model.ProjectAccess{}, errScopedWitness
}
func (s testScopedProjects) UpdateSettings(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.UpdateProjectSettings) (model.Project, error) {
	s.w.method = "UpdateSettings"
	s.w.auth = a
	s.w.args = []any{id, input}
	return model.Project{}, errScopedWitness
}
func (s testScopedProjects) TransferPreview(ctx context.Context, a model.CredentialAuthorization, id, target string) (coreproject.TransferPreview, error) {
	s.w.method = "TransferPreview"
	s.w.auth = a
	s.w.args = []any{id, target}
	return coreproject.TransferPreview{}, errScopedWitness
}
func (s testScopedProjects) Transfer(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	s.w.method = "Transfer"
	s.w.auth = a
	s.w.args = []any{id, input}
	return coreproject.TransferReceipt{}, errScopedWitness
}
func (s testScopedProjects) DeletionPreview(ctx context.Context, a model.CredentialAuthorization, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
	s.w.method = "DeletionPreview"
	s.w.auth = a
	s.w.args = []any{id, page}
	return projectservice.DeletionPreview{}, errScopedWitness
}
func (s testScopedProjects) DeleteWithInput(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.DeletionInput) (projectservice.DeletionReceipt, error) {
	s.w.method = "DeleteWithInput"
	s.w.auth = a
	s.w.args = []any{id, input}
	return projectservice.DeletionReceipt{}, errScopedWitness
}
func (s testScopedProjects) RepositoryPreview(ctx context.Context, a model.CredentialAuthorization, id, address, expected string) (coreproject.RepositoryPreview, error) {
	s.w.method = "RepositoryPreview"
	s.w.auth = a
	s.w.args = []any{id, address, expected}
	return coreproject.RepositoryPreview{}, errScopedWitness
}
func (s testScopedProjects) SetRepository(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
	s.w.method = "SetRepository"
	s.w.auth = a
	s.w.args = []any{id, input}
	return coreproject.RepositoryReceipt{}, errScopedWitness
}

type testScopedMemberships struct {
	scopedMemberships
	w *scopedRouteWitness
}

func (s testScopedMemberships) SearchMemberCandidates(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.CandidateSearchInput) (coreproject.CandidatePage, error) {
	s.w.method = "SearchMemberCandidates"
	s.w.auth = a
	s.w.args = []any{id, input}
	return coreproject.CandidatePage{}, errScopedWitness
}
func (s testScopedMemberships) ListWithAccess(ctx context.Context, a model.CredentialAuthorization, id string) (coreproject.ProjectParticipants, error) {
	s.w.method = "ListWithAccess"
	s.w.auth = a
	s.w.args = []any{id}
	return coreproject.ProjectParticipants{}, errScopedWitness
}
func (s testScopedMemberships) SetRole(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
	s.w.method = "SetRole"
	s.w.auth = a
	s.w.args = []any{projectID, userID, input}
	return model.ProjectGrant{}, errScopedWitness
}
func (s testScopedMemberships) Remove(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.RemoveProjectMember) error {
	s.w.method = "Remove"
	s.w.auth = a
	s.w.args = []any{projectID, userID, input}
	return errScopedWitness
}
func (s testScopedMemberships) SetGrant(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error) {
	s.w.method = "SetGrant"
	s.w.auth = a
	s.w.args = []any{projectID, userID, input}
	return coreproject.SetGrantResult{}, errScopedWitness
}
func (s testScopedMemberships) RemoveGrant(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error) {
	s.w.method = "RemoveGrant"
	s.w.auth = a
	s.w.args = []any{projectID, userID, input}
	return coreproject.RemoveGrantResult{}, errScopedWitness
}
func (s testScopedMemberships) CreateInvitation(ctx context.Context, a model.CredentialAuthorization, id, expected string) (coreproject.MintedInvitation, error) {
	s.w.method = "CreateInvitation"
	s.w.auth = a
	s.w.args = []any{id, expected}
	return coreproject.MintedInvitation{}, errScopedWitness
}
func (s testScopedMemberships) ListInvitations(ctx context.Context, a model.CredentialAuthorization, id string) ([]model.ProjectInvitation, error) {
	s.w.method = "ListInvitations"
	s.w.auth = a
	s.w.args = []any{id}
	return nil, errScopedWitness
}
func (s testScopedMemberships) RevokeInvitation(ctx context.Context, a model.CredentialAuthorization, id, invitation, expected string) error {
	s.w.method = "RevokeInvitation"
	s.w.auth = a
	s.w.args = []any{id, invitation, expected}
	return errScopedWitness
}
func (s testScopedMemberships) InspectInvitation(ctx context.Context, a model.CredentialAuthorization, secret string) (coreproject.InvitationInspection, error) {
	s.w.method = "InspectInvitation"
	s.w.auth = a
	s.w.args = []any{secret}
	return coreproject.InvitationInspection{}, errScopedWitness
}
func (s testScopedMemberships) AcceptInvitation(ctx context.Context, a model.CredentialAuthorization, secret, expected string) (coreproject.InvitationAcceptance, error) {
	s.w.method = "AcceptInvitation"
	s.w.auth = a
	s.w.args = []any{secret, expected}
	return coreproject.InvitationAcceptance{}, errScopedWitness
}

type testScopedDirectMembers struct {
	scopedDirectMembers
	w *scopedRouteWitness
}

func (s testScopedDirectMembers) AddExistingMember(ctx context.Context, a model.CredentialAuthorization, projectID, target, expected string) (coreproject.ExistingMemberResult, error) {
	s.w.method = "AddExistingMember"
	s.w.auth = a
	s.w.args = []any{projectID, target, expected}
	return coreproject.ExistingMemberResult{}, errScopedWitness
}

func TestScopedAdaptersBindEveryProjectOperationToRequestAuthorization(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
	good := context.WithValue(context.Background(), scopedAuthorizationKey{}, auth)
	witness := &scopedRouteWitness{}
	projects := ScopedProjectsAdapter{testScopedProjects{w: witness}}
	members := ScopedMembershipsAdapter{testScopedMemberships{w: witness}}
	direct := ScopedDirectMembersAdapter{testScopedDirectMembers{w: witness}}
	tests := []struct {
		name string
		args []any
		call func(context.Context) error
	}{
		{"ScopedProjectsAdapter.CreateWithAccess", []any{coreproject.CreateProject{}}, func(ctx context.Context) error {
			_, _, err := projects.CreateWithAccess(ctx, principal, coreproject.CreateProject{})
			return err
		}},
		{"ScopedProjectsAdapter.GetWithAccess", []any{"id"}, func(ctx context.Context) error { _, _, err := projects.GetWithAccess(ctx, principal, "id"); return err }},
		{"ScopedProjectsAdapter.ListScoped", []any{coreproject.ProjectListRequest{}}, func(ctx context.Context) error {
			_, err := projects.ListScoped(ctx, principal, coreproject.ProjectListRequest{})
			return err
		}},
		{"ScopedProjectsAdapter.Access", []any{"id"}, func(ctx context.Context) error { _, err := projects.Access(ctx, principal, "id"); return err }},
		{"ScopedProjectsAdapter.UpdateSettings", []any{"id", coreproject.UpdateProjectSettings{}}, func(ctx context.Context) error {
			_, err := projects.UpdateSettings(ctx, principal, "id", coreproject.UpdateProjectSettings{})
			return err
		}},
		{"ScopedProjectsAdapter.TransferPreview", []any{"id", "target"}, func(ctx context.Context) error {
			_, err := projects.TransferPreview(ctx, principal, "id", "target")
			return err
		}},
		{"ScopedProjectsAdapter.Transfer", []any{"id", coreproject.TransferInput{}}, func(ctx context.Context) error {
			_, err := projects.Transfer(ctx, principal, "id", coreproject.TransferInput{})
			return err
		}},
		{"ScopedProjectsAdapter.DeletionPreview", []any{"id", model.PageRequest{}}, func(ctx context.Context) error {
			_, err := projects.DeletionPreview(ctx, principal, "id", model.PageRequest{})
			return err
		}},
		{"ScopedProjectsAdapter.DeleteWithInput", []any{"id", coreproject.DeletionInput{}}, func(ctx context.Context) error {
			_, err := projects.DeleteWithInput(ctx, principal, "id", coreproject.DeletionInput{})
			return err
		}},
		{"ScopedProjectsAdapter.RepositoryPreview", []any{"id", "address", "expected"}, func(ctx context.Context) error {
			_, err := projects.RepositoryPreview(ctx, principal, "id", "address", "expected")
			return err
		}},
		{"ScopedProjectsAdapter.SetRepository", []any{"id", coreproject.RepositoryChange{}}, func(ctx context.Context) error {
			_, err := projects.SetRepository(ctx, principal, "id", coreproject.RepositoryChange{})
			return err
		}},
		{"ScopedMembershipsAdapter.SearchMemberCandidates", []any{"id", coreproject.CandidateSearchInput{}}, func(ctx context.Context) error {
			_, err := members.SearchMemberCandidates(ctx, principal, "id", coreproject.CandidateSearchInput{})
			return err
		}},
		{"ScopedMembershipsAdapter.ListWithAccess", []any{"id"}, func(ctx context.Context) error { _, err := members.ListWithAccess(ctx, principal, "id"); return err }},
		{"ScopedMembershipsAdapter.SetRole", []any{"project", "user", coreproject.SetProjectMemberRole{}}, func(ctx context.Context) error {
			_, err := members.SetRole(ctx, principal, "project", "user", coreproject.SetProjectMemberRole{})
			return err
		}},
		{"ScopedMembershipsAdapter.Remove", []any{"project", "user", coreproject.RemoveProjectMember{}}, func(ctx context.Context) error {
			return members.Remove(ctx, principal, "project", "user", coreproject.RemoveProjectMember{})
		}},
		{"ScopedMembershipsAdapter.SetGrant", []any{"project", "user", coreproject.SetProjectGrant{}}, func(ctx context.Context) error {
			_, err := members.SetGrant(ctx, principal, "project", "user", coreproject.SetProjectGrant{})
			return err
		}},
		{"ScopedMembershipsAdapter.RemoveGrant", []any{"project", "user", coreproject.RemoveProjectMember{}}, func(ctx context.Context) error {
			_, err := members.RemoveGrant(ctx, principal, "project", "user", coreproject.RemoveProjectMember{})
			return err
		}},
		{"ScopedMembershipsAdapter.CreateInvitation", []any{"id", "expected"}, func(ctx context.Context) error {
			_, err := members.CreateInvitation(ctx, principal, "id", "expected")
			return err
		}},
		{"ScopedMembershipsAdapter.ListInvitations", []any{"id"}, func(ctx context.Context) error { _, err := members.ListInvitations(ctx, principal, "id"); return err }},
		{"ScopedMembershipsAdapter.RevokeInvitation", []any{"id", "invitation", "expected"}, func(ctx context.Context) error {
			return members.RevokeInvitation(ctx, principal, "id", "invitation", "expected")
		}},
		{"ScopedMembershipsAdapter.InspectInvitation", []any{"secret"}, func(ctx context.Context) error {
			_, err := members.InspectInvitation(ctx, principal, "secret")
			return err
		}},
		{"ScopedMembershipsAdapter.AcceptInvitation", []any{"secret", "expected"}, func(ctx context.Context) error {
			_, err := members.AcceptInvitation(ctx, principal, "secret", "expected")
			return err
		}},
		{"ScopedDirectMembersAdapter.AddExistingMember", []any{"project", "target", "expected"}, func(ctx context.Context) error {
			_, err := direct.AddExistingMember(ctx, principal, "project", "target", "expected")
			return err
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			witness.method = ""
			witness.args = nil
			if err := tc.call(context.Background()); err == nil || witness.method != "" {
				t.Fatalf("missing authorization reached service: %v, %s", err, witness.method)
			}
			if err := tc.call(good); !errors.Is(err, errScopedWitness) || witness.auth.Principal != principal || witness.auth.Profile != auth.Profile || witness.auth.Policy != auth.Policy || witness.method != strings.Split(tc.name, ".")[1] || !reflect.DeepEqual(witness.args, tc.args) {
				t.Fatalf("authorization not forwarded: %v, %+v", err, witness)
			}
		})
	}
}
