package project

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type repositoryFactsProject struct {
	facts store.ProjectRepositoryFacts
	err   error
}

func (d repositoryFactsProject) RepositoryFacts(context.Context, model.Principal) (store.ProjectRepositoryFacts, error) {
	return d.facts, d.err
}

type repositoryFactsGitHub struct {
	facts           store.GitHubProjectAppFacts
	factErr, appErr error
	app             store.GitHubProjectApp
	calls, appCalls *int
}

func (d repositoryFactsGitHub) Facts(context.Context, model.Principal) (store.GitHubProjectAppFacts, error) {
	(*d.calls)++
	return d.facts, d.factErr
}
func (d repositoryFactsGitHub) App(_ context.Context, app, grant, team string) (store.GitHubProjectApp, error) {
	(*d.appCalls)++
	if app != "app" || grant != "grant" || team != "team" {
		return store.GitHubProjectApp{}, errors.New("incorrect App scope")
	}
	return d.app, d.appErr
}

func TestRepositoryFactsAuthorizationAndAppReadFailures(t *testing.T) {
	appID, grantID := "app", "grant"
	cause := errors.New("storage unavailable")
	base := store.ProjectRepositoryFacts{Version: 1, Access: model.ProjectAccess{Role: model.ProjectAdmin}, Project: model.Project{Ownership: model.ProjectOwnership{TeamID: "team"}}}
	for _, tc := range []struct {
		name                          string
		project                       store.ProjectRepositoryFacts
		projectErr, githubErr, appErr error
		binding                       bool
		wantErr                       error
		wantFault                     string
		wantApp                       bool
		wantFactsCalls, wantAppCalls  int
	}{
		{name: "missing project", project: base, projectErr: model.ErrNotFound, wantFault: "not_found"},
		{name: "invalid persisted version", project: store.ProjectRepositoryFacts{Version: 0}, wantErr: errors.New("invalid stored repository version")},
		{name: "member", project: store.ProjectRepositoryFacts{Version: 1, Access: model.ProjectAccess{Role: model.ProjectMemberRole}}, wantFault: "forbidden"},
		{name: "connection read failure", project: base, githubErr: cause, wantErr: cause, wantFactsCalls: 1},
		{name: "App unavailable", project: base, binding: true, appErr: model.ErrNotFound, wantFactsCalls: 1, wantAppCalls: 1},
		{name: "App read failure", project: base, binding: true, appErr: cause, wantErr: cause, wantFactsCalls: 1, wantAppCalls: 1},
		{name: "App present", project: base, binding: true, wantApp: true, wantFactsCalls: 1, wantAppCalls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, appCalls := 0, 0
			g := repositoryFactsGitHub{factErr: tc.githubErr, appErr: tc.appErr, app: store.GitHubProjectApp{ID: appID}, calls: &calls, appCalls: &appCalls}
			if tc.binding {
				g.facts.AppResourceID = &appID
				g.facts.GrantID = &grantID
			}
			got, err := repositoryFacts(t.Context(), model.Principal{}, repositoryFactsProject{tc.project, tc.projectErr}, g)
			if tc.wantFault != "" {
				transferFault(t, err, tc.wantFault)
			} else if tc.wantErr != nil {
				if err == nil || (tc.wantErr == cause && !errors.Is(err, cause)) || (tc.wantErr != cause && err.Error() != tc.wantErr.Error()) {
					t.Fatalf("failure not retained: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if (got.app != nil) != tc.wantApp || calls != tc.wantFactsCalls || appCalls != tc.wantAppCalls {
				t.Fatalf("app=%v calls=%d app calls=%d", got.app, calls, appCalls)
			}
		})
	}
}

func TestRepositoryOperationsRejectBeforeStoreAccess(t *testing.T) {
	p := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "44444444-4444-4444-8444-444444444444", Kind: model.SessionCredential}
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	s := &AppProjects{}
	if _, err := s.RepositoryPreview(t.Context(), p, "bad", "https://example.com/a", p.UserID); err == nil {
		t.Fatal("invalid project accepted")
	}
	if _, err := s.RepositoryPreview(t.Context(), p, id, "https://example.com/a", p.UserID); err == nil || err.Error() != "repository store unavailable" {
		t.Fatalf("missing store: %v", err)
	}
	input := core.RepositoryChange{RepoURL: "https://example.com/a", ExpectedUserID: p.UserID, RepositoryVersion: 1, OwnershipVersion: 1, Classification: "same_repository"}
	if _, err := s.SetRepository(t.Context(), p, "bad", input); err == nil {
		t.Fatal("invalid project accepted")
	}
	invalidVersion := input
	invalidVersion.RepositoryVersion = 0
	if _, err := s.SetRepository(t.Context(), p, id, invalidVersion); err == nil {
		t.Fatal("invalid version accepted")
	}
	if _, err := s.SetRepository(t.Context(), p, id, input); err == nil || err.Error() != "repository store unavailable" {
		t.Fatalf("missing store: %v", err)
	}
}

func TestRepositoryPreviewLegacyUnknownIdentity(t *testing.T) {
	s, db, actor, p := repositoryChangeFixture(t)
	if _, err := db.Pool.Exec(t.Context(), `UPDATE projects SET repository_identity=NULL WHERE id=$1`, p.ID); err != nil {
		t.Fatal(err)
	}
	preview, err := s.RepositoryPreview(t.Context(), actor, p.ID, "https://example.com/new", actor.UserID)
	if err != nil || preview.Classification != "unverified" || preview.UnverifiedReason == nil {
		t.Fatalf("legacy preview: %+v %v", preview, err)
	}
}

func TestRepositoryChangeRefusesExhaustedProjectVersion(t *testing.T) {
	s, db, actor, p := repositoryChangeFixture(t)
	if _, err := db.Pool.Exec(t.Context(), `UPDATE projects SET repository_version=$2 WHERE id=$1`, p.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	preview, err := s.RepositoryPreview(t.Context(), actor, p.ID, "https://example.com/new", actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	before := repositoryState(t, db, p.ID)
	input := repositoryChangeInput(preview, actor)
	input.TreatUnverifiedAsSwitch = true
	_, err = s.SetRepository(t.Context(), actor, p.ID, input)
	transferFault(t, err, "version_exhausted")
	if after := repositoryState(t, db, p.ID); after != before {
		t.Fatal("exhausted version changed state")
	}
}
