package service

import (
	"context"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type membershipFixture struct {
	database    *store.Store
	projects    *projectservice.Projects
	memberships *projectservice.Memberships
	now         time.Time
}

func newMembershipFixture(t *testing.T) *membershipFixture {
	t.Helper()
	projects, database, _, _ := projectService(t)
	f := &membershipFixture{database: database, projects: projects, memberships: projectservice.NewMemberships(database), now: time.Now().UTC().Truncate(time.Microsecond)}

	return f
}

func (f *membershipFixture) user(t *testing.T) model.Principal {
	t.Helper()
	secret := secretutil.Random("dnst_")
	credential := model.Session{ID: uuid.NewString(), TokenHash: secretutil.Hash(secret), CreatedAt: f.now, ExpiresAt: f.now.Add(identitycore.SessionLifetime)}
	principal := fixtureIdentitySession(t, f.database, model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}, credential)

	return principal
}

func (f *membershipFixture) project(t *testing.T, p model.Principal, name string) model.Project {
	t.Helper()
	project, err := f.projects.Create(context.Background(), p, coreproject.CreateProject{ExpectedUserID: p.UserID, Name: name, RepoURL: "https://example.com/team/repo.git"})
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func (f *membershipFixture) invite(t *testing.T, p model.Principal, projectID string) coreproject.MintedInvitation {
	t.Helper()
	invitation, err := f.memberships.CreateInvitation(context.Background(), p, projectID, p.UserID)
	if err != nil {
		t.Fatal(err)
	}
	return invitation
}

func (f *membershipFixture) join(t *testing.T, admin, p model.Principal, projectID string) model.ProjectMember {
	t.Helper()
	invite := f.invite(t, admin, projectID)
	_, err := f.memberships.AcceptInvitation(context.Background(), p, invite.Secret, p.UserID)
	if err != nil {
		t.Fatal(err)
	}
	return f.member(t, p, projectID)
}

func (f *membershipFixture) member(t *testing.T, p model.Principal, projectID string) model.ProjectMember {
	t.Helper()
	var member model.ProjectMember
	if err := f.database.ReadSnapshot(context.Background(), func(snapshot store.SnapshotScope) error {
		var err error
		member, err = snapshot.ProjectDAO().DirectProjectMember(context.Background(), p.UserID, projectID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return member
}
