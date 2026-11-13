package github

import (
	"context"
	"errors"
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
func TestManagerSettingsAndDisconnect(t *testing.T) {
	s, r := mgmtFixture()
	m := NewManager(s, r, 13)
	status, err := m.Settings(context.Background(), mgmtPrincipal, mgmtProject, 1, 7)
	if err != nil || s.write.github.w == nil || s.write.github.w.PollIntervalMinutes != 7 || status.Connection.Version != 2 {
		t.Fatalf("settings %+v %v", status, err)
	}
	s, r = mgmtFixture()
	s.write.github.c.Enabled = true
	m = NewManager(s, r, 13)
	status, err = m.Disconnect(context.Background(), mgmtPrincipal, mgmtProject, 1)
	if err != nil || s.write.github.w == nil || s.write.github.w.Enabled || status.Connection.Version != 2 {
		t.Fatalf("disconnect %+v %v", status, err)
	}
}

type proofCoverageRemote struct {
	mgmtRemote
	fail string
}

func (r *proofCoverageRemote) ResolveRepository(context.Context, int64, int64) (githubpr.RepositoryObservation, error) {
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
	if r.fail == "discover" {
		return githubpr.InstallationObservation{}, errors.New("offline")
	}
	id := int64(99)
	if r.fail == "installation" {
		id = 100
	}
	return githubpr.InstallationObservation{ID: id, AccountLogin: "provider"}, nil
}
func TestProofBoundFailures(t *testing.T) {
	for _, failure := range []string{"resolve", "identity", "name", "verify", "changed", "discover", "installation"} {
		t.Run(failure, func(t *testing.T) {
			s, _ := mgmtFixture()
			r := &proofCoverageRemote{fail: failure}
			_, err := NewManager(s, r, 13).proofBound(context.Background(), 99, 42)
			if err == nil {
				t.Fatal("proof accepted failure")
			}
			var m *ManagementError
			var f *model.Fault
			if !errors.As(err, &m) && !errors.As(err, &f) {
				t.Fatalf("unexpected classification %v", err)
			}
		})
	}
}

func TestDiscoverRejectsInvalidAndUnavailableRequests(t *testing.T) {
	for _, tc := range []struct {
		name, id string
		prepare  func(*mgmtStore, *mgmtRemote)
	}{
		{"invalid-id", "invalid", func(*mgmtStore, *mgmtRemote) {}},
		{"member", mgmtProject, func(s *mgmtStore, _ *mgmtRemote) { s.snapshot.projects.role = model.ProjectMemberRole }},
		{"not-github", mgmtProject, func(s *mgmtStore, _ *mgmtRemote) { s.snapshot.projects.repo = "https://example.com/o/r" }},
		{"upstream", mgmtProject, func(_ *mgmtStore, r *mgmtRemote) { r.err = errors.New("offline") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r := mgmtFixture()
			tc.prepare(s, r)
			_, err := NewManager(s, r, 13).Discover(context.Background(), mgmtPrincipal, tc.id)
			if err == nil || s.writes != 0 {
				t.Fatalf("discovery refusal: %v", err)
			}
		})
	}
}
