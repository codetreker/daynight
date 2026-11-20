package github

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type configAdmissionFixture struct {
	store.GitHubAppConfigReader
	access store.GitHubAppConfigAccess
	err    error
}

func (f configAdmissionFixture) ConfigAccess(context.Context, string) (store.GitHubAppConfigAccess, error) {
	return f.access, f.err
}

func TestAppConfigAdmissionPreservesVisibilityVersionsAndErrors(t *testing.T) {
	ctx := t.Context()
	denied := errors.New("scope denied")
	upstream := errors.New("database failure")
	proof := &AppUpdateProof{MembershipVersion: 3}
	impact := int64(4)
	for _, tc := range []struct {
		name    string
		dao     store.GitHubAppConfigReader
		version int64
		proof   *AppUpdateProof
		impact  *int64
		want    string
		cause   error
	}{
		{"capability", struct{ store.GitHubAppConfigReader }{}, 2, nil, nil, "", nil},
		{"missing", configAdmissionFixture{err: model.ErrNotFound}, 2, nil, nil, "not_found", model.ErrNotFound},
		{"lost admin", configAdmissionFixture{err: model.ErrNotFound}, 2, proof, nil, "github_admin_changed", model.ErrNotFound},
		{"error", configAdmissionFixture{err: upstream}, 2, nil, nil, "", upstream},
		{"membership", configAdmissionFixture{access: store.GitHubAppConfigAccess{MembershipVersion: 2}}, 2, proof, nil, "github_admin_changed", nil},
		{"version", configAdmissionFixture{access: store.GitHubAppConfigAccess{MembershipVersion: 3, AppVersion: 1}}, 2, proof, nil, "version_conflict", nil},
		{"impact", configAdmissionFixture{access: store.GitHubAppConfigAccess{MembershipVersion: 3, AppVersion: 2, ImpactVersion: 2}}, 2, proof, &impact, "impact_changed", nil},
		{"scope", configAdmissionFixture{access: store.GitHubAppConfigAccess{MembershipVersion: 3, AppVersion: 2, ImpactVersion: 4}}, 2, proof, &impact, "", denied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := admitAppConfig(ctx, tc.dao, "actor", tc.version, tc.proof, tc.impact, func() error { return denied })
			if err == nil {
				t.Fatal("expected refusal")
			}
			if tc.want != "" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != tc.want {
					t.Fatalf("got %v", err)
				}
			}
			if tc.cause != nil && !errors.Is(err, tc.cause) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
}

type projectAdmissionFixture struct {
	store.GitHubProjectAppReadDAO
	version int64
	err     error
}

func (f projectAdmissionFixture) ProjectAppAccess(context.Context, model.Principal) (store.GitHubProjectAppAccess, error) {
	return store.GitHubProjectAppAccess{}, f.err
}
func (f projectAdmissionFixture) ProjectAppVersion(context.Context, string, string, string) (int64, error) {
	return f.version, f.err
}

func TestSelectedProjectAppAdmissionBoundaries(t *testing.T) {
	admin, member := model.ProjectAdmin, model.ProjectMemberRole
	in := ProjectAppSelection{OwnershipVersion: 2, AppVersion: 3}
	base := store.GitHubProjectAppAccess{Access: model.ProjectAccess{TeamRole: &admin}, OwnershipVersion: 2}
	upstream := errors.New("database failure")
	for _, tc := range []struct {
		name  string
		dao   store.GitHubProjectAppReadDAO
		facts store.GitHubProjectAppAccess
		want  string
		cause error
	}{
		{"role", projectAdmissionFixture{}, store.GitHubProjectAppAccess{Access: model.ProjectAccess{TeamRole: &member}}, "forbidden", nil},
		{"ownership", projectAdmissionFixture{}, store.GitHubProjectAppAccess{Access: model.ProjectAccess{TeamRole: &admin}, OwnershipVersion: 1}, "version_conflict", nil},
		{"capability", struct{ store.GitHubProjectAppReadDAO }{}, base, "", nil},
		{"missing", projectAdmissionFixture{err: model.ErrNotFound}, base, "github_grant_changed", model.ErrNotFound},
		{"error", projectAdmissionFixture{err: upstream}, base, "", upstream},
		{"app version", projectAdmissionFixture{version: 1}, base, "version_conflict", nil},
		{"success", projectAdmissionFixture{version: 3}, base, "success", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := RequireSelectedProjectApp(t.Context(), tc.dao, tc.facts, in)
			if tc.want == "success" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected refusal")
			}
			if tc.want != "" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != tc.want {
					t.Fatalf("got %v", err)
				}
			}
			if tc.cause != nil && !errors.Is(err, tc.cause) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
}
