package project

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type patInvitationDAO struct {
	settingsWriteDAO
	insert func(context.Context, model.ProjectInvitation) error
}

func (d patInvitationDAO) CreateInvitation(ctx context.Context, invitation model.ProjectInvitation) error {
	return d.insert(ctx, invitation)
}

func TestMembershipPATAndOperationalFailurePropagation(t *testing.T) {
	admin := projectProjectionPrincipal(1)
	pat := admin
	pat.Kind = model.PATCredential
	pat.CredentialID = "ab000000-0000-4000-8000-000000000099"
	ctx := t.Context()
	now := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	project := projectPageItem(1, now)
	projectID := strings.ToUpper(project.ID)

	reader := resourceProjectPlan(t, ctx, pat, project, personalProjectCreatorAccess(project, pat), "access", "participants")
	reader.participants = []model.ProjectParticipant{{UserID: pat.UserID, EffectiveRole: model.ProjectAdmin}}
	db := resourceProjectDatabase(t, ctx, project.ID, reader)
	members, err := NewMemberships(db).List(ctx, pat, project.ID)
	want := []model.ProjectParticipant{{UserID: pat.UserID, EffectiveRole: model.ProjectAdmin}}
	if err != nil || !reflect.DeepEqual(members, want) {
		t.Fatalf("PAT membership list: %#v, %v, want %#v", members, err, want)
	}

	minted := mintProjectInvitationWithPAT(t, ctx, pat, project, now)
	input := coreproject.CreateProject{ExpectedUserID: pat.UserID, Name: "PAT project", RepoURL: "host:repo"}
	creation := newPersonalProjectCreationPlan(t, ctx, pat, input)
	created, err := NewProjects(creation).Create(ctx, pat, input)
	if err != nil || created != creation.proposed {
		t.Fatalf("create Project with PAT: %#v, %v, want %#v", created, err, creation.proposed)
	}

	canceled, cancel := context.WithCancel(ctx)
	cancel()
	read := newCompletionProjectReadPlan(t, canceled, nil)
	read.begin = &store.Error{Phase: "begin snapshot", Cause: canceled.Err()}
	members, err = NewMemberships(read).List(canceled, admin, projectID)
	assertOperational(t, err)
	if members != nil || !errors.Is(err, read.begin) || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled membership list returned data or lost its cause: %#v, %v", members, err)
	}

	closed := errors.New("closed pool")
	snapshotFailure := func(t *testing.T) (*completionProjectReadPlan, *store.Error) {
		t.Helper()
		failure := &store.Error{Phase: "begin snapshot", Cause: closed, DatabaseFailure: true}
		read := newCompletionProjectReadPlan(t, t.Context(), nil)
		read.begin = failure
		return read, failure
	}
	t.Run("membership list", func(t *testing.T) {
		read, failure := snapshotFailure(t)
		result, err := NewMemberships(read).List(t.Context(), admin, projectID)
		assertProjectStoreFailure(t, result, err, failure)
	})
	t.Run("create invitation", func(t *testing.T) {
		ctx := t.Context()
		failure := &store.Error{Phase: "begin project write", Cause: closed, DatabaseFailure: true}
		calls := 0
		db := settingsWriteStore{write: func(actual context.Context, id string, _ func(store.ProjectWriteScope) error) (store.Completion, error) {
			calls++
			if calls != 1 || actual != ctx || id != project.ID {
				t.Fatalf("begin invitation write: calls=%d same context=%v project=%q, want %q", calls, actual == ctx, id, project.ID)
			}
			return store.Completion{Outcome: store.TransactionNotCommitted}, failure
		}}
		result, err := NewMemberships(db).CreateInvitation(ctx, admin, projectID, admin.UserID)
		assertProjectStoreFailure(t, result, err, failure)
		if calls != 1 {
			t.Fatalf("invitation write calls=%d, want 1", calls)
		}
	})
	t.Run("inspect invitation", func(t *testing.T) {
		read, failure := snapshotFailure(t)
		result, err := NewMemberships(read).InspectInvitation(t.Context(), admin, minted.Secret)
		assertProjectStoreFailure(t, result, err, failure)
	})
	t.Run("create Project", func(t *testing.T) {
		ctx := t.Context()
		failure := &store.Error{Phase: "begin project creation", Cause: closed, DatabaseFailure: true}
		calls := 0
		db := projectCreationBeginFailure{begin: func(actual context.Context, ownerID string) (store.Completion, error) {
			calls++
			if calls != 1 || actual != ctx || ownerID != admin.UserID {
				t.Fatalf("begin Project creation: calls=%d same context=%v owner=%q, want %q", calls, actual == ctx, ownerID, admin.UserID)
			}
			return store.Completion{Outcome: store.TransactionNotCommitted}, failure
		}}
		result, err := NewProjects(db).Create(ctx, admin, coreproject.CreateProject{
			ExpectedUserID: admin.UserID, Name: "Failure", RepoURL: "host:repo",
		})
		assertProjectStoreFailure(t, result, err, failure)
		if calls != 1 {
			t.Fatalf("Project creation calls=%d, want 1", calls)
		}
	})
	t.Run("Project list", func(t *testing.T) {
		read, failure := snapshotFailure(t)
		result, err := NewProjects(read).List(t.Context(), admin, model.PageRequest{Limit: 1})
		assertProjectStoreFailure(t, result, err, failure)
	})
}

func mintProjectInvitationWithPAT(t *testing.T, ctx context.Context, pat model.Principal, project model.Project, now time.Time) coreproject.MintedInvitation {
	t.Helper()
	pending := []string{"WriteProject", "ProjectDAO", "ProjectAccess", "CreateInvitation"}
	expect := func(actual context.Context, name string) {
		t.Helper()
		if ctx != actual || len(pending) == 0 || pending[0] != name {
			t.Fatalf("unexpected PAT invitation call %s: same context=%v pending=%v", name, ctx == actual, pending)
		}
		pending = pending[1:]
	}
	var inserted model.ProjectInvitation
	dao := patInvitationDAO{
		settingsWriteDAO: settingsWriteDAO{access: func(actual context.Context, principal model.Principal) (model.ProjectAccess, error) {
			expect(actual, "ProjectAccess")
			if principal != pat {
				t.Fatalf("invitation caller=%#v, want PAT %#v", principal, pat)
			}
			return personalProjectCreatorAccess(project, pat), nil
		}},
		insert: func(actual context.Context, invitation model.ProjectInvitation) error {
			expect(actual, "CreateInvitation")
			id, err := uuid.Parse(invitation.ID)
			if err != nil || id.Version() != 4 || invitation.ProjectID != project.ID || invitation.CreatedBy != pat.UserID ||
				!invitation.CreatedAt.Equal(now) || !invitation.ExpiresAt.Equal(now.Add(coreproject.InvitationLifetime)) {
				t.Fatal("invalid invitation identity, project, creator or lifetime")
			}
			inserted = invitation
			inserted.TokenHash = bytes.Clone(invitation.TokenHash)
			return nil
		},
	}
	db := settingsWriteStore{write: func(actual context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		expect(actual, "WriteProject")
		if id != project.ID {
			t.Fatalf("invitation write Project=%q, want %q", id, project.ID)
		}
		err := work(settingsWriteScope{project: func() store.ProjectWriteDAO {
			expect(actual, "ProjectDAO")
			return dao
		}})
		if err != nil {
			t.Fatalf("PAT invitation callback failed: %v", err)
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	memberships := NewMemberships(db)
	memberships.now = func() time.Time { return now }
	minted, err := memberships.CreateInvitation(ctx, pat, strings.ToUpper(project.ID), pat.UserID)
	want := inserted
	want.TokenHash = nil
	if err != nil || !secretutil.Valid(minted.Secret, "dninvite_") || !bytes.Equal(inserted.TokenHash, secretutil.Hash(minted.Secret)) ||
		!reflect.DeepEqual(minted.Invitation, want) || len(pending) != 0 {
		t.Fatalf("PAT invitation did not return the minted public material: err=%v pending=%v", err, pending)
	}
	return minted
}
