package github

import (
	"context"
	"errors"
	"reflect"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func TestManagementRemoteErrorClassification(t *testing.T) {
	for _, tc := range []struct{ upstream, code string }{{"rate_limited", "github_rate_limited"}, {"unauthorized", "github_permission_denied"}, {"not_found", "github_installation_missing"}, {"unavailable", "github_unavailable"}} {
		t.Run(tc.upstream, func(t *testing.T) {
			cause := &remote.Error{Code: tc.upstream, Status: 403}
			err := remoteError(cause)
			var m *ManagementError
			if !errors.As(err, &m) || m.Code != tc.code || !errors.Is(err, cause) || m.Error() == "" {
				t.Fatalf("classification: %v", err)
			}
		})
	}
	if remoteError(nil) != nil {
		t.Fatal("nil became error")
	}
}

type proofCoverageRemote struct {
	mgmtRemote
	fail  string
	calls []string
}

func (r *proofCoverageRemote) ResolveRepository(context.Context, int64, int64) (githubpr.RepositoryObservation, error) {
	r.calls = append(r.calls, "resolve")
	if r.fail == "resolve" {
		return githubpr.RepositoryObservation{}, errors.New("offline")
	}
	id := int64(42)
	name := "owner/repo"
	if r.fail == "identity" {
		id = 43
	}
	if r.fail == "name" {
		name = "invalid"
	}
	return githubpr.RepositoryObservation{ID: id, FullName: name}, nil
}
func (r *proofCoverageRemote) VerifyAccess(context.Context, int64, string, string) (githubpr.RepositoryObservation, error) {
	r.calls = append(r.calls, "verify")
	if r.fail == "verify" {
		return githubpr.RepositoryObservation{}, errors.New("offline")
	}
	id := int64(42)
	if r.fail == "changed" {
		id = 43
	}
	return githubpr.RepositoryObservation{ID: id, FullName: "owner/repo"}, nil
}
func (r *proofCoverageRemote) DiscoverInstallation(context.Context, string, string) (githubpr.InstallationObservation, error) {
	r.calls = append(r.calls, "discover")
	if r.fail == "discover" {
		return githubpr.InstallationObservation{}, errors.New("offline")
	}
	id := int64(99)
	if r.fail == "installation" {
		id = 100
	}
	return githubpr.InstallationObservation{ID: id, AccountLogin: "provider"}, nil
}
func (r *proofCoverageRemote) FindInstallationByRepository(context.Context, int64) (githubpr.InstallationObservation, error) {
	r.calls = append(r.calls, "scan")
	return githubpr.InstallationObservation{}, errors.New("unexpected installation scan")
}
func TestProofBoundFailures(t *testing.T) {
	for _, tc := range []struct {
		failure, code string
		calls         []string
	}{
		{"resolve", "github_unavailable", []string{"resolve"}},
		{"identity", "github_repository_mismatch", []string{"resolve"}},
		{"name", "github_unavailable", []string{"resolve"}},
		{"verify", "github_unavailable", []string{"resolve", "verify"}},
		{"changed", "github_repository_mismatch", []string{"resolve", "verify"}},
		{"discover", "github_unavailable", []string{"resolve", "verify", "discover"}},
		{"installation", "github_permission_denied", []string{"resolve", "verify", "discover"}},
	} {
		t.Run(tc.failure, func(t *testing.T) {
			r := &proofCoverageRemote{fail: tc.failure}
			_, err := (&repositoryProof{remote: r}).proofBound(context.Background(), 99, 42)
			assertManagementCode(t, err, tc.code)
			if !reflect.DeepEqual(r.calls, tc.calls) {
				t.Fatalf("unexpected calls %v", r.calls)
			}
		})
	}
}

func assertManagementCode(t *testing.T, err error, want string) {
	t.Helper()
	var m *ManagementError
	var f *model.Fault
	got := ""
	if errors.As(err, &m) {
		got = m.Code
	} else if errors.As(err, &f) {
		got = f.Code
	}
	if got != want {
		t.Fatalf("error code %q, want %q; error %v", got, want, err)
	}
}

type retainedDiscoveryRemote struct {
	calls      []string
	discovery  map[string]error
	identities map[string]int64
	resolveErr error
	scanErr    error
}

func (r *retainedDiscoveryRemote) DiscoverInstallation(_ context.Context, owner, name string) (githubpr.InstallationObservation, error) {
	r.calls = append(r.calls, "discover "+owner+"/"+name)
	if err := r.discovery[name]; err != nil {
		return githubpr.InstallationObservation{}, err
	}
	return githubpr.InstallationObservation{ID: 55, AccountLogin: owner}, nil
}
func (r *retainedDiscoveryRemote) VerifyAccess(_ context.Context, installation int64, owner, name string) (githubpr.RepositoryObservation, error) {
	r.calls = append(r.calls, "verify "+owner+"/"+name)
	if installation != 55 || r.identities[name] == 0 {
		return githubpr.RepositoryObservation{}, errors.New("unexpected proof target")
	}
	return githubpr.RepositoryObservation{ID: r.identities[name], FullName: owner + "/" + name, Private: true}, nil
}
func (r *retainedDiscoveryRemote) ResolveRepository(_ context.Context, installation, repository int64) (githubpr.RepositoryObservation, error) {
	r.calls = append(r.calls, "resolve")
	if installation != 55 || repository != 42 {
		return githubpr.RepositoryObservation{}, errors.New("unexpected retained identity")
	}
	if r.resolveErr != nil {
		return githubpr.RepositoryObservation{}, r.resolveErr
	}
	return githubpr.RepositoryObservation{ID: 42, FullName: "owner/renamed", Private: true}, nil
}
func (r *retainedDiscoveryRemote) FindInstallationByRepository(_ context.Context, repository int64) (githubpr.InstallationObservation, error) {
	r.calls = append(r.calls, "scan")
	if repository != 42 {
		return githubpr.InstallationObservation{}, errors.New("unexpected scan identity")
	}
	return githubpr.InstallationObservation{}, r.scanErr
}

func TestDiscoverPreservesRetainedRepositoryIdentityAndFailures(t *testing.T) {
	missing := &remote.Error{Code: "not_found", Status: 404}
	limited := &remote.Error{Code: "rate_limited", Status: 429}
	for _, tc := range []struct {
		name       string
		remote     retainedDiscoveryRemote
		savedName  bool
		oldInstall bool
		wantCode   string
		wantCalls  []string
	}{
		{"reused name and complete absence", retainedDiscoveryRemote{identities: map[string]int64{"old": 43, "repo": 44}, scanErr: missing}, true, false, "github_repository_mismatch", []string{"discover owner/old", "verify owner/old", "discover owner/repo", "verify owner/repo", "scan"}},
		{"renamed repository under retained installation", retainedDiscoveryRemote{discovery: map[string]error{"old": missing, "repo": missing}, identities: map[string]int64{"renamed": 42}}, true, true, "", []string{"discover owner/old", "discover owner/repo", "resolve", "verify owner/renamed", "discover owner/renamed"}},
		{"retained installation rate limited", retainedDiscoveryRemote{discovery: map[string]error{"old": missing, "repo": missing}, resolveErr: limited}, true, true, "github_rate_limited", []string{"discover owner/old", "discover owner/repo", "resolve"}},
		{"name discovery rate limited", retainedDiscoveryRemote{discovery: map[string]error{"repo": limited}}, false, false, "github_rate_limited", []string{"discover owner/repo"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repository, installation, saved := int64(42), int64(55), "owner/old"
			connection := githubpr.DefaultConnection(mgmtProject)
			connection.RepositoryID = &repository
			if tc.savedName {
				connection.RepositoryFullName = &saved
			}
			if tc.oldInstall {
				connection.InstallationID = &installation
			}
			candidate, err := (&repositoryProof{remote: &tc.remote}).discoverSnapshot(t.Context(), managementSnapshot{project: model.Project{RepoURL: "https://github.com/owner/repo"}, connection: connection})
			if tc.wantCode == "" {
				if err != nil || candidate.Repository.ID != 42 || candidate.Repository.FullName != "owner/renamed" || candidate.Installation.ID != 55 {
					t.Fatalf("candidate=%+v error=%v", candidate, err)
				}
			} else {
				assertManagementCode(t, err, tc.wantCode)
				if candidate != (core.InstallationCandidate{}) {
					t.Fatalf("failure returned candidate=%+v", candidate)
				}
			}
			if !reflect.DeepEqual(tc.remote.calls, tc.wantCalls) {
				t.Fatalf("calls=%v want=%v", tc.remote.calls, tc.wantCalls)
			}
		})
	}
}
