package project

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func sessionAuthorization(p model.Principal) model.CredentialAuthorization {
	return model.CredentialAuthorization{Principal: p, Profile: model.SessionProfile}
}
func requireScopeDenial(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("expected scope refusal, got %v", err)
	}
}

func TestScopedProjectReadCreateAndSettings(t *testing.T) {
	f := newMembershipFixture(t)
	owner := f.user(t)
	app := NewScopedProjects(NewAppProjects(f.database))
	ctx := t.Context()
	creation := core.CreateProject{Name: "Scoped create", RepoURL: "https://example.com/scoped-create", ExpectedUserID: owner.UserID}
	_, err := app.Create(ctx, scopedPAT(t, owner, "project:write"), creation)
	requireScopeDenial(t, err)
	project, err := app.Create(ctx, sessionAuthorization(owner), creation)
	if err != nil || project.Name != creation.Name {
		t.Fatalf("create=%+v err=%v", project, err)
	}
	noRead := scopedPAT(t, owner, "project:write")
	_, err = app.Get(ctx, noRead, project.ID)
	requireScopeDenial(t, err)
	_, err = app.Access(ctx, noRead, project.ID)
	requireScopeDenial(t, err)
	_, err = app.List(ctx, noRead, model.PageRequest{Limit: 10})
	requireScopeDenial(t, err)
	_, err = app.ResolveRepository(ctx, noRead, project.RepoURL)
	requireScopeDenial(t, err)
	read := scopedPAT(t, owner, "project:read")
	got, access, err := app.GetWithAccess(ctx, read, project.ID)
	if err != nil || got.ID != project.ID || access.UserID != owner.UserID {
		t.Fatalf("get=%+v access=%+v err=%v", got, access, err)
	}
	got, err = app.Get(ctx, read, project.ID)
	if err != nil || got.ID != project.ID {
		t.Fatalf("get=%+v err=%v", got, err)
	}
	a, err := app.Access(ctx, read, project.ID)
	if err != nil || a.UserID != owner.UserID {
		t.Fatalf("access=%+v err=%v", a, err)
	}
	list, err := app.List(ctx, read, model.PageRequest{Limit: 10})
	if err != nil || len(list.Items) != 1 || list.Items[0].ID != project.ID {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	got, err = app.ResolveRepository(ctx, read, project.RepoURL)
	if err != nil || got.ID != project.ID {
		t.Fatalf("resolve=%+v err=%v", got, err)
	}
	input := core.UpdateProjectSettings{Version: project.Settings.Version, ExecutionWarningMinutes: project.Settings.ExecutionWarningMinutes + 1}
	_, err = app.UpdateSettings(ctx, noRead, project.ID, input)
	requireScopeDenial(t, err)
	before, err := f.projects.Get(ctx, owner, project.ID)
	if err != nil || before.Settings != project.Settings {
		t.Fatalf("settings mutated on refusal: %+v %v", before.Settings, err)
	}
	settings := scopedPAT(t, owner, "project:read", "project:write")
	changed, err := app.UpdateSettings(ctx, settings, project.ID, input)
	if err != nil || changed.Settings.ExecutionWarningMinutes != input.ExecutionWarningMinutes {
		t.Fatalf("settings=%+v err=%v", changed.Settings, err)
	}
	_, err = app.UpdateSettings(ctx, settings, project.ID, input)
	transferFault(t, err, "version_conflict")
	_, _, err = app.CreateWithAccess(ctx, model.CredentialAuthorization{}, creation)
	if err == nil {
		t.Fatal("unconfigured authorization admitted")
	}
	_, _, err = app.RegisterRepository(ctx, noRead, creation, true)
	requireScopeDenial(t, err)
	_, err = app.ListScoped(ctx, model.CredentialAuthorization{}, core.ProjectListRequest{Page: model.PageRequest{Limit: 10}})
	if err == nil {
		t.Fatal("missing authorization admitted")
	}
	_, err = app.ListScoped(ctx, read, core.ProjectListRequest{Page: model.PageRequest{Limit: 0}})
	transferFault(t, err, "invalid_input")
}

func TestScopedProjectTransferRepositoryAndDeletion(t *testing.T) {
	app, _, actor, project := repositoryChangeFixture(t)
	scoped := NewScopedProjects(app)
	ctx := t.Context()
	transfer := scopedPAT(t, actor, "project:transfer")
	preview, err := scoped.TransferPreview(ctx, transfer, project.ID, project.Ownership.TeamID)
	if err != nil || preview.Ownership.TeamID != project.Ownership.TeamID {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	named, name, err := scoped.TransferPreviewWithName(ctx, transfer, project.ID, project.Ownership.TeamID)
	if err != nil || name != project.Name || named.Ownership != preview.Ownership {
		t.Fatalf("named=%+v name=%q err=%v", named, name, err)
	}
	_, _, err = scoped.TransferPreviewWithName(ctx, scopedPAT(t, actor, "project:read"), project.ID, project.Ownership.TeamID)
	requireScopeDenial(t, err)
	_, _, err = scoped.TransferPreviewWithName(ctx, model.CredentialAuthorization{}, project.ID, project.Ownership.TeamID)
	if err == nil {
		t.Fatal("invalid authorization admitted")
	}
	_, _, err = scoped.TransferPreviewWithName(ctx, transfer, "bad", project.Ownership.TeamID)
	transferFault(t, err, "invalid_input")
	_, _, err = scoped.TransferPreviewWithName(ctx, transfer, project.ID, "00000000-0000-4000-8000-000000000001")
	transferFault(t, err, "not_found")
	fullTransfer := scopedPAT(t, actor, "project:read", "project:transfer")
	receipt, err := scoped.Transfer(ctx, fullTransfer, project.ID, transferInput(preview, actor))
	if err != nil || receipt.Changed || receipt.ProjectID != project.ID {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	stale := transferInput(preview, actor)
	stale.Ownership.Version++
	_, err = scoped.Transfer(ctx, fullTransfer, project.ID, stale)
	transferFault(t, err, "version_conflict")
	repo := scopedPAT(t, actor, "project:repository")
	repositoryPreview, err := scoped.RepositoryPreview(ctx, repo, project.ID, project.RepoURL, actor.UserID)
	if err != nil || repositoryPreview.Classification != "unchanged" {
		t.Fatalf("preview=%+v err=%v", repositoryPreview, err)
	}
	repositoryReceipt, err := scoped.SetRepository(ctx, repo, project.ID, repositoryChangeInput(repositoryPreview, actor))
	if err != nil || repositoryReceipt.Changed {
		t.Fatalf("repository=%+v err=%v", repositoryReceipt, err)
	}
	staleRepo := repositoryChangeInput(repositoryPreview, actor)
	staleRepo.RepositoryVersion++
	_, err = scoped.SetRepository(ctx, repo, project.ID, staleRepo)
	transferFault(t, err, "version_conflict")
	deletion := scopedPAT(t, actor, "attachment:read", "project:delete", "task:read", "worker:read")
	deletionPreview, err := scoped.DeletionPreview(ctx, deletion, project.ID, model.PageRequest{Limit: 10})
	if err != nil || deletionPreview.Project.ID != project.ID {
		t.Fatalf("deletion preview=%+v err=%v", deletionPreview, err)
	}
}

func TestScopedMembershipOperations(t *testing.T) {
	f := newMembershipFixture(t)
	owner, member, second := f.user(t), f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped memberships")
	joined := f.join(t, owner, member, project.ID)
	joinedSecond := f.join(t, owner, second, project.ID)
	svc := NewScopedMemberships(f.memberships, nil)
	ctx := t.Context()
	onlyMembers := scopedPAT(t, owner, "project:members")
	read := scopedPAT(t, owner, "project:read")
	members, err := svc.List(ctx, read, project.ID)
	if err != nil || len(members) != 3 {
		t.Fatalf("members=%+v err=%v", members, err)
	}
	_, err = svc.ListWithAccess(ctx, onlyMembers, project.ID)
	requireScopeDenial(t, err)
	full := scopedPAT(t, owner, "project:members", "project:read")
	setRole := core.SetProjectMemberRole{Version: joined.Grant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID}
	_, err = svc.SetRole(ctx, onlyMembers, project.ID, member.UserID, setRole)
	requireScopeDenial(t, err)
	after := f.member(t, member, project.ID)
	if after.Grant.Role != joined.Grant.Role || after.Grant.Version != joined.Grant.Version {
		t.Fatalf("scope refusal modified role: %+v", after)
	}
	grant, err := svc.SetRole(ctx, full, project.ID, member.UserID, setRole)
	if err != nil || grant.Role != model.ProjectAdmin || grant.Version <= joined.Grant.Version {
		t.Fatalf("grant=%+v err=%v", grant, err)
	}
	_, err = svc.SetRole(ctx, full, project.ID, member.UserID, setRole)
	transferFault(t, err, "version_conflict")
	remove := core.RemoveProjectMember{Version: grant.Version, ExpectedUserID: owner.UserID}
	err = svc.Remove(ctx, read, project.ID, member.UserID, remove)
	requireScopeDenial(t, err)
	if got := f.member(t, member, project.ID); got.Grant.Version != grant.Version {
		t.Fatalf("scope refusal removed grant: %+v", got)
	}
	if err = svc.Remove(ctx, onlyMembers, project.ID, member.UserID, remove); err != nil {
		t.Fatalf("remove: %v", err)
	}
	removeSecond := core.RemoveProjectMember{Version: joinedSecond.Grant.Version, ExpectedUserID: owner.UserID}
	_, err = svc.RemoveGrant(ctx, onlyMembers, project.ID, second.UserID, removeSecond)
	requireScopeDenial(t, err)
	result, err := svc.RemoveGrant(ctx, full, project.ID, second.UserID, removeSecond)
	if err != nil || result.ProjectID != project.ID || result.ActorAccess == nil {
		t.Fatalf("remove grant=%+v err=%v", result, err)
	}
	_, err = svc.RemoveGrant(ctx, full, project.ID, second.UserID, removeSecond)
	transferFault(t, err, "version_conflict")
	_, err = svc.List(ctx, model.CredentialAuthorization{}, project.ID)
	if err == nil {
		t.Fatal("invalid authorization admitted")
	}
}

func TestScopedInvitationOperations(t *testing.T) {
	f := newMembershipFixture(t)
	owner, recipient := f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped invitations")
	svc := NewScopedMemberships(f.memberships, nil)
	ctx := t.Context()
	read := scopedPAT(t, owner, "project:read")
	_, err := svc.CreateInvitation(ctx, read, project.ID, owner.UserID)
	requireScopeDenial(t, err)
	manage := scopedPAT(t, owner, "project:invitations")
	invite, err := svc.CreateInvitation(ctx, manage, project.ID, owner.UserID)
	if err != nil || invite.Secret == "" {
		t.Fatalf("invitation=%+v err=%v", invite, err)
	}
	_, err = svc.ListInvitations(ctx, read, project.ID)
	requireScopeDenial(t, err)
	list, err := svc.ListInvitations(ctx, manage, project.ID)
	if err != nil || len(list) != 1 || list[0].ID != invite.Invitation.ID {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	err = svc.RevokeInvitation(ctx, read, project.ID, invite.Invitation.ID, owner.UserID)
	requireScopeDenial(t, err)
	list, err = svc.ListInvitations(ctx, manage, project.ID)
	if err != nil || len(list) != 1 {
		t.Fatalf("refusal revoked invitation: %+v %v", list, err)
	}
	inspect := scopedPAT(t, recipient, "project:invitation-read", "project:read")
	got, err := svc.InspectInvitation(ctx, inspect, invite.Secret)
	if err != nil || got.ProjectID != project.ID || got.ProjectName != project.Name {
		t.Fatalf("inspection=%+v err=%v", got, err)
	}
	_, err = svc.InspectInvitation(ctx, model.CredentialAuthorization{}, invite.Secret)
	if err == nil {
		t.Fatal("invalid authorization admitted")
	}
	_, err = svc.InspectInvitationBasic(ctx, read, invite.Secret)
	requireScopeDenial(t, err)
	_, err = svc.InspectInvitationBasic(ctx, model.CredentialAuthorization{}, invite.Secret)
	if err == nil {
		t.Fatal("invalid basic inspection admitted")
	}
	_, err = svc.AcceptInvitation(ctx, scopedPAT(t, recipient, "project:read"), invite.Secret, recipient.UserID)
	requireScopeDenial(t, err)
	assertNoDirectGrant(t, f, project.ID, recipient.UserID)
	accept := scopedPAT(t, recipient, "project:invitation-accept", "project:read")
	result, err := svc.AcceptInvitation(ctx, accept, invite.Secret, recipient.UserID)
	if err != nil || !result.Joined || result.ProjectID != project.ID {
		t.Fatalf("accepted=%+v err=%v", result, err)
	}
	_, err = svc.AcceptInvitationReceipt(ctx, accept, invite.Secret, recipient.UserID)
	if err == nil {
		t.Fatal("consumed invitation accepted twice")
	}
	_, err = svc.AcceptInvitation(ctx, accept, invite.Secret, "bad")
	transferFault(t, err, "invalid_input")
	_, err = svc.AcceptInvitation(ctx, model.CredentialAuthorization{}, invite.Secret, recipient.UserID)
	if err == nil {
		t.Fatal("invalid acceptance admitted")
	}
	newInvite, err := svc.CreateInvitation(ctx, manage, project.ID, owner.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.RevokeInvitation(ctx, manage, project.ID, newInvite.Invitation.ID, owner.UserID); err != nil {
		t.Fatal(err)
	}
	_, err = svc.InspectInvitationBasic(ctx, inspect, newInvite.Secret)
	if err == nil {
		t.Fatal("revoked invitation inspected")
	}
}

func TestScopedDirectMemberCallbackOutcomes(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped direct authorization")
	initial := sessionAuthorization(owner)
	ctx := t.Context()
	legacy := NewDirectMembers(f.database, directCredentialResource)
	_, err := NewScopedDirectMembers(legacy, nil).AddExistingMember(ctx, initial, project.ID, target.UserID, owner.UserID)
	if err == nil {
		t.Fatal("missing callback admitted")
	}
	_, err = NewScopedDirectMembers(legacy, nil).AddExistingMember(ctx, model.CredentialAuthorization{}, project.ID, target.UserID, owner.UserID)
	if err == nil {
		t.Fatal("invalid authorization admitted")
	}
	deny := errors.New("authorization unavailable")
	svc := NewScopedDirectMembers(legacy, func(context.Context, store.ProjectDirectMemberScope, model.Principal) (model.CredentialAuthorization, error) {
		return model.CredentialAuthorization{}, deny
	})
	_, err = svc.AddExistingMember(ctx, initial, project.ID, target.UserID, owner.UserID)
	if !errors.Is(err, deny) {
		t.Fatalf("authority error: %v", err)
	}
	assertNoDirectGrant(t, f, project.ID, target.UserID)
	calls := 0
	svc = NewScopedDirectMembers(legacy, func(_ context.Context, scope store.ProjectDirectMemberScope, p model.Principal) (model.CredentialAuthorization, error) {
		calls++
		if scope == nil || p != owner {
			t.Error("incorrect transaction or actor")
		}
		return initial, nil
	})
	out, err := svc.AddExistingMember(ctx, initial, project.ID, target.UserID, owner.UserID)
	if err != nil || !out.Added || out.Participant.UserID != target.UserID || calls != 2 {
		t.Fatalf("result=%+v calls=%d err=%v", out, calls, err)
	}
}

func TestScopedCandidateAuthorizationFailures(t *testing.T) {
	ctx := t.Context()
	p := model.Principal{Kind: model.PATCredential, UserID: candidateActor, CredentialID: candidateTarget}
	scope := &candidateScope{t: t, ctx: ctx, p: p, access: model.ProjectAccess{Role: model.ProjectAdmin}}
	snapshot := &candidateSnapshot{scope: scope}
	cause := errors.New("authorization lookup failed")
	svc := NewScopedMemberships(&Memberships{store: snapshot}, func(_ context.Context, s store.SnapshotScope, got model.Principal) (model.CredentialAuthorization, error) {
		if s != scope || got != p {
			t.Error("incorrect snapshot or actor")
		}
		return model.CredentialAuthorization{}, cause
	})
	_, err := svc.SearchMemberCandidates(ctx, model.CredentialAuthorization{}, candidateProject, core.CandidateSearchInput{})
	if err == nil || snapshot.calls != 0 {
		t.Fatalf("invalid credential: err=%v snapshots=%d", err, snapshot.calls)
	}
	actor := scopedPAT(t, p, "project:members")
	page, err := svc.SearchMemberCandidates(ctx, actor, candidateProject, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: "alice"})
	if !errors.Is(err, cause) || len(page.Items) != 0 || snapshot.calls != 1 {
		t.Fatalf("page=%+v err=%v snapshots=%d", page, err, snapshot.calls)
	}
	for _, call := range scope.calls {
		if call == "search" {
			t.Fatal("directory queried after authority failure")
		}
	}
}
