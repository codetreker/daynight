package github

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

const mgmtProject = "11111111-1111-4111-8111-111111111111"

var mgmtPrincipal = model.Principal{Kind: model.SessionCredential, UserID: "22222222-2222-4222-8222-222222222222", CredentialID: "33333333-3333-4333-8333-333333333333"}

type mgmtRemote struct {
	discover, verify, resolve int
	name                      string
	repositoryID              int64
	verifyID                  int64
	err                       error
	id                        int64
}

func (r *mgmtRemote) DiscoverInstallation(_ context.Context, o, n string) (githubpr.InstallationObservation, error) {
	r.discover++
	if o != "owner" || n != r.name {
		panic("wrong target")
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, r.err
}
func (r *mgmtRemote) VerifyAccess(_ context.Context, id int64, o, n string) (githubpr.RepositoryObservation, error) {
	r.verify++
	if id != r.id {
		panic("wrong installation")
	}
	return githubpr.RepositoryObservation{ID: r.verifyID, FullName: "owner/" + r.name, Private: true}, r.err
}
func (r *mgmtRemote) ResolveRepository(_ context.Context, installationID, repositoryID int64) (githubpr.RepositoryObservation, error) {
	r.resolve++
	if installationID != r.id || repositoryID != r.repositoryID {
		return githubpr.RepositoryObservation{}, errors.New("incorrect stable identity")
	}
	return githubpr.RepositoryObservation{ID: r.repositoryID, FullName: "owner/" + r.name, Private: true}, r.err
}
func (r *mgmtRemote) FindInstallationByRepository(_ context.Context, repositoryID int64) (githubpr.InstallationObservation, error) {
	if repositoryID != r.repositoryID {
		return githubpr.InstallationObservation{}, errors.New("incorrect stable identity")
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, r.err
}

type discoveryFallbackRemote struct {
	*mgmtRemote
	findCalls int
	findErr   error
}

func (r *discoveryFallbackRemote) DiscoverInstallation(_ context.Context, owner, name string) (githubpr.InstallationObservation, error) {
	r.discover++
	if name != "renamed-again" {
		return githubpr.InstallationObservation{}, &remote.Error{Code: "not_found", Status: 404}
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, nil
}
func (r *discoveryFallbackRemote) FindInstallationByRepository(_ context.Context, id int64) (githubpr.InstallationObservation, error) {
	r.findCalls++
	if id != r.repositoryID {
		return githubpr.InstallationObservation{}, errors.New("incorrect repository ID")
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, r.findErr
}
func (r *discoveryFallbackRemote) ResolveRepository(_ context.Context, installationID, repositoryID int64) (githubpr.RepositoryObservation, error) {
	r.resolve++
	if installationID != r.id {
		return githubpr.RepositoryObservation{}, &remote.Error{Code: "installation_missing", Status: 404}
	}
	if repositoryID != r.repositoryID {
		return githubpr.RepositoryObservation{}, errors.New("incorrect repository ID")
	}
	return githubpr.RepositoryObservation{ID: repositoryID, FullName: "owner/renamed-again", Private: true}, nil
}
func (r *discoveryFallbackRemote) VerifyAccess(_ context.Context, id int64, owner, name string) (githubpr.RepositoryObservation, error) {
	r.verify++
	if id != r.id || owner != "owner" || name != "renamed-again" {
		return githubpr.RepositoryObservation{}, errors.New("incorrect verified identity")
	}
	return githubpr.RepositoryObservation{ID: r.verifyID, FullName: "owner/renamed-again", Private: true}, nil
}
func TestDiscoverScansCurrentAppWhenOldNameAndInstallationAreGone(t *testing.T) {
	for _, tc := range []struct {
		name     string
		scanErr  error
		wantCode string
	}{
		{"found", nil, ""},
		{"timed out", context.DeadlineExceeded, "github_unavailable"},
		{"inaccessible installation", errors.Join(remote.ErrInstallationScanIncomplete, &remote.Error{Code: "not_found", Status: 404}), "github_unavailable"},
		{"rate limited", &remote.Error{Code: "rate_limited", Status: 429}, "github_rate_limited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := &mgmtRemote{id: 99, name: "repo", repositoryID: 42, verifyID: 42}
			r := &discoveryFallbackRemote{mgmtRemote: base, findErr: tc.scanErr}
			repositoryID := int64(42)
			oldInstallation := int64(55)
			oldName := "owner/renamed"
			connection := githubpr.DefaultConnection(mgmtProject)
			connection.RepositoryID = &repositoryID
			connection.InstallationID = &oldInstallation
			connection.RepositoryFullName = &oldName
			candidate, err := (&repositoryProof{remote: r}).discoverSnapshot(context.Background(), managementSnapshot{project: model.Project{RepoURL: "https://github.com/owner/repo"}, connection: connection})
			if r.findCalls != 1 {
				t.Fatalf("scan calls %d", r.findCalls)
			}
			if tc.wantCode == "" {
				if err != nil || candidate.Installation.ID != 99 || candidate.Repository.ID != 42 || candidate.Repository.FullName != "owner/renamed-again" || r.verify != 1 {
					t.Fatalf("candidate %+v err %v", candidate, err)
				}
				return
			}
			var failure *ManagementError
			if !errors.As(err, &failure) || failure.Code != tc.wantCode {
				t.Fatalf("failure %v", err)
			}
		})
	}
}

func TestRepositoryProofBoundRetainsIdentityAfterRename(t *testing.T) {
	for _, verifiedID := range []int64{42, 43} {
		r := &mgmtRemote{id: 99, name: "renamed", repositoryID: 42, verifyID: verifiedID}
		candidate, err := (&repositoryProof{remote: r}).proofBound(context.Background(), 99, 42)
		if verifiedID == 42 {
			if err != nil || candidate.Repository.ID != 42 || candidate.Repository.FullName != "owner/renamed" || candidate.Installation.ID != 99 || r.resolve != 1 || r.verify != 1 || r.discover != 1 {
				t.Fatalf("renamed candidate=%+v calls=%+v err=%v", candidate, r, err)
			}
		} else {
			assertManagementCode(t, err, "github_repository_mismatch")
			if r.resolve != 1 || r.verify != 1 || r.discover != 0 {
				t.Fatalf("identity mismatch calls=%+v", r)
			}
		}
	}
}

func TestRepositoryProofFindsRetainedNameUnderReplacementInstallation(t *testing.T) {
	r := &mgmtRemote{id: 99, name: "renamed", repositoryID: 42, verifyID: 42}
	id, previous, name := int64(42), int64(55), "owner/renamed"
	connection := githubpr.DefaultConnection(mgmtProject)
	connection.RepositoryID, connection.InstallationID, connection.RepositoryFullName = &id, &previous, &name
	candidate, err := (&repositoryProof{remote: r}).discoverSnapshot(context.Background(), managementSnapshot{project: model.Project{RepoURL: "https://github.com/owner/repo"}, connection: connection})
	if err != nil || candidate.Installation.ID != 99 || candidate.Repository.ID != 42 || r.resolve != 0 || r.discover != 1 || r.verify != 1 {
		t.Fatalf("replacement candidate=%+v calls=%+v err=%v", candidate, r, err)
	}
}
