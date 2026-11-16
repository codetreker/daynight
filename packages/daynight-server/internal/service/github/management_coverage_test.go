package github

import (
	"context"
	"errors"
	"reflect"
	"testing"

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
