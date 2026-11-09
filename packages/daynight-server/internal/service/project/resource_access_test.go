package project

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type resourceProjectStore struct {
	store.ProjectCreationWriter
	t         *testing.T
	ctx       context.Context
	snapshots []store.ProjectReader
	write     func(func(store.ProjectWriteScope) error) error
	projectID string
}

func (s *resourceProjectStore) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	if ctx != s.ctx || len(s.snapshots) == 0 {
		s.t.Errorf("unexpected Project snapshot: context=%v remaining=%d", ctx == s.ctx, len(s.snapshots))
		return errors.New("unexpected Project snapshot")
	}
	dao := s.snapshots[0]
	s.snapshots = s.snapshots[1:]
	return operation(resourceProjectSnapshot{dao: dao})
}

func (s *resourceProjectStore) WriteProject(ctx context.Context, id string, operation func(store.ProjectWriteScope) error) (store.Completion, error) {
	if ctx != s.ctx || id != s.projectID || s.write == nil {
		s.t.Errorf("unexpected Project write: context=%v id=%q", ctx == s.ctx, id)
		return store.Completion{}, errors.New("unexpected Project write")
	}
	write := s.write
	s.write = nil
	return store.Completion{Outcome: store.TransactionCommitted}, write(operation)
}

type resourceProjectSnapshot struct {
	store.SnapshotScope
	dao store.ProjectReader
}

func (s resourceProjectSnapshot) ProjectDAO() store.ProjectReader { return s.dao }

type resourceProjectReader struct {
	store.ProjectReader
	t            *testing.T
	ctx          context.Context
	principal    model.Principal
	projectID    string
	access       model.ProjectAccess
	accessErr    error
	project      model.Project
	participants []model.ProjectParticipant
	page         store.ProjectPage
	calls        []string
}

func (d *resourceProjectReader) called(ctx context.Context, name string) {
	d.t.Helper()
	if ctx != d.ctx || len(d.calls) == 0 || d.calls[0] != name {
		d.t.Errorf("unexpected Project DAO call %s: context=%v remaining=%v", name, ctx == d.ctx, d.calls)
		return
	}
	d.calls = d.calls[1:]
}

func (d *resourceProjectReader) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	d.called(ctx, "access")
	if p != d.principal || id != d.projectID {
		d.t.Errorf("Project access arguments: %+v %q", p, id)
	}
	return d.access, d.accessErr
}

func (d *resourceProjectReader) Project(ctx context.Context, id string) (model.Project, error) {
	d.called(ctx, "project")
	if id != d.projectID {
		d.t.Errorf("Project read ID %q", id)
	}
	return d.project, nil
}

func (d *resourceProjectReader) ScopedProjects(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	d.called(ctx, "list")
	if p != d.principal || scope != (store.ProjectScope{Kind: store.ProjectScopeAll}) || !reflect.DeepEqual(page, store.Page{Limit: 1}) {
		d.t.Errorf("Project list arguments: %+v %+v %+v", p, scope, page)
	}
	return d.page, nil
}

func (d *resourceProjectReader) ProjectParticipants(ctx context.Context, id string) ([]model.ProjectParticipant, error) {
	d.called(ctx, "participants")
	if id != d.projectID {
		d.t.Errorf("Project participant ID %q", id)
	}
	return d.participants, nil
}

func resourceProjectFacts(t *testing.T) (context.Context, model.Principal, model.Project, model.ProjectAccess) {
	t.Helper()
	p := model.Principal{Kind: model.SessionCredential, UserID: "ab000000-0000-4000-8000-000000000001", CredentialID: "ab000000-0000-4000-8000-000000000002"}
	project := model.Project{ID: "cd000000-0000-4000-8000-000000000001", Name: "  Personal inherited resources  ", RepoURL: "https://example.com/team/repo.git", CreatedAt: time.Date(2026, 1, 1, 1, 2, 3, 0, time.UTC), UpdatedAt: time.Date(2026, 1, 1, 1, 2, 3, 0, time.UTC), Ownership: model.ProjectOwnership{TeamID: "ef000000-0000-4000-8000-000000000001", Version: 1}, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}}
	role := model.ProjectAdmin
	access := model.ProjectAccess{ProjectID: project.ID, UserID: p.UserID, Role: role, OwnerTeam: model.TeamRef{ID: project.Ownership.TeamID, Kind: "personal"}, Ownership: project.Ownership, TeamRole: &role, CanTransfer: true}
	return t.Context(), p, project, access
}

func resourceProjectPlan(t *testing.T, ctx context.Context, p model.Principal, project model.Project, access model.ProjectAccess, calls ...string) *resourceProjectReader {
	t.Helper()
	d := &resourceProjectReader{t: t, ctx: ctx, principal: p, projectID: project.ID, project: project, access: access, calls: calls, page: store.ProjectPage{Items: []model.Project{project}}}
	t.Cleanup(func() {
		if len(d.calls) != 0 {
			t.Errorf("unconsumed Project DAO calls: %v", d.calls)
		}
	})
	return d
}

func resourceProjectDatabase(t *testing.T, ctx context.Context, projectID string, reads ...store.ProjectReader) *resourceProjectStore {
	t.Helper()
	s := &resourceProjectStore{t: t, ctx: ctx, projectID: projectID, snapshots: reads}
	t.Cleanup(func() {
		if len(s.snapshots) != 0 || s.write != nil {
			t.Errorf("unconsumed Project scopes: reads=%d write=%t", len(s.snapshots), s.write != nil)
		}
	})
	return s
}

func TestProjectReadsPreserveInheritedOwnership(t *testing.T) {
	ctx, p, project, access := resourceProjectFacts(t)
	get := resourceProjectPlan(t, ctx, p, project, access, "access", "project")
	actor := resourceProjectPlan(t, ctx, p, project, access, "access")
	list := resourceProjectPlan(t, ctx, p, project, access, "list")
	db := resourceProjectDatabase(t, ctx, project.ID, get, actor, list)
	projects := NewProjects(db)
	value, err := projects.Get(ctx, p, strings.ToUpper(project.ID))
	if err != nil || !reflect.DeepEqual(value, project) {
		t.Fatalf("inherited Project data: %+v %v", value, err)
	}
	gotAccess, err := projects.Access(ctx, p, project.ID)
	if err != nil || !reflect.DeepEqual(gotAccess, access) || gotAccess.DirectGrant != nil {
		t.Fatalf("inherited Project access: %+v %v", gotAccess, err)
	}
	page, err := projects.List(ctx, p, model.PageRequest{Limit: 1})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], project) || page.NextCursor != nil {
		t.Fatalf("inherited Project page: %+v %v", page, err)
	}
}

func TestProjectAndParticipantProjectionsShareOneScope(t *testing.T) {
	ctx, p, project, access := resourceProjectFacts(t)
	next := project
	next.Ownership = model.ProjectOwnership{TeamID: "ef000000-0000-4000-8000-000000000002", Version: 9007199254740993}
	grant := model.ProjectGrant{ProjectID: project.ID, UserID: p.UserID, Role: model.ProjectAdmin, Version: 1}
	nextAccess := access
	nextAccess.Ownership, nextAccess.OwnerTeam = next.Ownership, model.TeamRef{ID: next.Ownership.TeamID, Kind: "ordinary"}
	nextAccess.TeamRole, nextAccess.CanTransfer, nextAccess.DirectGrant = nil, false, &grant
	before := resourceProjectPlan(t, ctx, p, project, access, "access", "project")
	after := resourceProjectPlan(t, ctx, p, next, nextAccess, "access", "project")
	db := resourceProjectDatabase(t, ctx, project.ID, before, after)
	subject := NewProjects(db)
	for _, expected := range []struct {
		project model.Project
		access  model.ProjectAccess
	}{{project, access}, {next, nextAccess}} {
		got, actor, err := subject.GetWithAccess(ctx, p, project.ID)
		if err != nil || !reflect.DeepEqual(got, expected.project) || !reflect.DeepEqual(actor, expected.access) || got.Ownership != actor.Ownership {
			t.Fatalf("Project/access projection: %+v %+v %v", got, actor, err)
		}
	}
	memberAccess := access
	memberAccess.OwnerTeam.Kind = "ordinary"
	member := resourceProjectPlan(t, ctx, p, project, memberAccess, "access", "participants")
	member.participants = []model.ProjectParticipant{{UserID: p.UserID, EffectiveRole: model.ProjectAdmin, InheritedFrom: &model.ProjectInheritance{Team: memberAccess.OwnerTeam, Role: model.ProjectAdmin}}}
	downgraded := memberAccess
	role := model.ProjectMemberRole
	downgraded.Role, downgraded.TeamRole, downgraded.CanTransfer = role, &role, false
	fresh := resourceProjectPlan(t, ctx, p, project, downgraded, "access")
	memberDB := resourceProjectDatabase(t, ctx, project.ID, member, fresh)
	participants, err := NewMemberships(memberDB).ListWithAccess(ctx, p, project.ID)
	if err != nil || participants.ActorAccess.Role != model.ProjectAdmin || !participants.ActorAccess.CanTransfer || participants.ActorAccess.DirectGrant != nil ||
		participants.ActorAccess.TeamRole == nil || *participants.ActorAccess.TeamRole != model.ProjectAdmin ||
		len(participants.Items) != 1 || participants.Items[0].EffectiveRole != model.ProjectAdmin || participants.Items[0].DirectGrant != nil ||
		participants.Items[0].InheritedFrom == nil || participants.Items[0].InheritedFrom.Role != model.ProjectAdmin ||
		!reflect.DeepEqual(participants.ActorAccess, memberAccess) || !reflect.DeepEqual(participants.Items, member.participants) {
		t.Fatalf("participant/access projection: %+v %v", participants, err)
	}
	current, err := NewProjects(memberDB).Access(ctx, p, project.ID)
	if err != nil || !reflect.DeepEqual(current, downgraded) || current.CanTransfer {
		t.Fatalf("fresh participant access: %+v %v", current, err)
	}
}

func TestProjectResourceAdmissionUsesCurrentAccess(t *testing.T) {
	ctx, p, project, access := resourceProjectFacts(t)
	for _, actor := range []model.Principal{{}, {UserID: p.UserID, CredentialID: p.CredentialID, Kind: "unknown"}} {
		_, err := NewProjects(nil).Get(ctx, actor, project.ID)
		requireFault(t, err, "unauthenticated")
	}
	memberAccess := access
	memberAccess.Role, memberAccess.TeamRole, memberAccess.CanTransfer = model.ProjectMemberRole, nil, false
	memberAccess.DirectGrant = &model.ProjectGrant{ProjectID: project.ID, UserID: p.UserID, Role: model.ProjectMemberRole, Version: 1}
	member := resourceProjectPlan(t, ctx, p, project, memberAccess, "access", "project")
	removed := resourceProjectPlan(t, ctx, p, project, access, "access")
	removed.access, removed.accessErr = model.ProjectAccess{}, model.ErrNotFound
	subject := NewProjects(resourceProjectDatabase(t, ctx, project.ID, member, removed))
	if got, err := subject.Get(ctx, p, project.ID); err != nil || !reflect.DeepEqual(got, project) {
		t.Fatalf("member Project read: %+v %v", got, err)
	}
	_, err := subject.Get(ctx, p, project.ID)
	requireFault(t, err, "not_found")
	outsider := p
	outsider.UserID = "ab000000-0000-4000-8000-000000000003"
	read := resourceProjectPlan(t, ctx, outsider, project, access, "access")
	read.access, read.accessErr = model.ProjectAccess{}, model.ErrNotFound
	_, err = NewProjects(resourceProjectDatabase(t, ctx, project.ID, read)).Get(ctx, outsider, project.ID)
	requireFault(t, err, "not_found")
	pat := p
	pat.Kind = model.PATCredential
	patAccess := access
	patAccess.DirectGrant = &model.ProjectGrant{ProjectID: project.ID, UserID: pat.UserID, Role: model.ProjectAdmin, Version: 1}
	patRead := resourceProjectPlan(t, ctx, pat, project, patAccess, "access", "project")
	if got, err := NewProjects(resourceProjectDatabase(t, ctx, project.ID, patRead)).Get(ctx, pat, project.ID); err != nil || !reflect.DeepEqual(got, project) {
		t.Fatalf("live PAT Project read: %+v %v", got, err)
	}
	empty := resourceProjectPlan(t, ctx, p, project, access, "list")
	empty.page = store.ProjectPage{Items: []model.Project{}}
	page, err := NewProjects(resourceProjectDatabase(t, ctx, project.ID, empty)).List(ctx, p, model.PageRequest{Limit: 1})
	if err != nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("removed member Project list: %+v %v", page, err)
	}
}

type resourceProjectSettings struct {
	store.ProjectWriteScope
	store.ProjectWriteDAO
	t      *testing.T
	ctx    context.Context
	p      model.Principal
	access model.ProjectAccess
	before model.Project
	after  model.Project
	calls  []string
}

func (d *resourceProjectSettings) ProjectDAO() store.ProjectWriteDAO { return d }
func (d *resourceProjectSettings) take(ctx context.Context, name string) {
	if ctx != d.ctx || len(d.calls) == 0 || d.calls[0] != name {
		d.t.Errorf("unexpected settings call %s: %v", name, d.calls)
		return
	}
	d.calls = d.calls[1:]
}
func (d *resourceProjectSettings) ProjectAccess(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
	d.take(ctx, "access")
	if p != d.p {
		d.t.Errorf("settings principal: %+v", p)
	}
	return d.access, nil
}
func (d *resourceProjectSettings) Project(ctx context.Context) (model.Project, error) {
	d.take(ctx, "project")
	return d.before, nil
}
func (d *resourceProjectSettings) UpdateProjectSettings(ctx context.Context, minutes int32) (model.Project, error) {
	d.take(ctx, "settings")
	if minutes != 45 {
		d.t.Errorf("settings minutes: %d", minutes)
	}
	return d.after, nil
}

func TestInheritedProjectAdministratorUpdatesSettings(t *testing.T) {
	ctx, p, project, access := resourceProjectFacts(t)
	changed := project
	changed.Settings = model.ProjectSettings{Version: 2, ExecutionWarningMinutes: 45}
	dao := &resourceProjectSettings{t: t, ctx: ctx, p: p, access: access, before: project, after: changed, calls: []string{"access", "project", "settings"}}
	db := resourceProjectDatabase(t, ctx, project.ID)
	db.write = func(operation func(store.ProjectWriteScope) error) error { return operation(dao) }
	got, err := NewProjects(db).UpdateSettings(ctx, p, project.ID, coreproject.UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 45})
	if err != nil || !reflect.DeepEqual(got, changed) || len(dao.calls) != 0 {
		t.Fatalf("inherited settings: %+v calls=%v %v", got, dao.calls, err)
	}
}
