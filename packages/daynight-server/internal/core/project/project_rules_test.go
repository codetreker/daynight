package project

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const testUser = "00000000-0000-4000-8000-000000000001"
const testProject = "00000000-0000-4000-8000-000000000002"
const testTeam = "00000000-0000-4000-8000-000000000003"

func testPrincipal() model.Principal {
	return model.Principal{UserID: testUser, CredentialID: testProject, Kind: model.SessionCredential}
}

type readProjectDAO struct {
	store.ProjectReader
	access     model.ProjectAccess
	accessErr  error
	project    model.Project
	projectErr error
	page       store.ProjectPage
	pageErr    error
	scope      store.ProjectScope
}

func (d *readProjectDAO) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return d.access, d.accessErr
}
func (d *readProjectDAO) Project(context.Context, string) (model.Project, error) {
	return d.project, d.projectErr
}
func (d *readProjectDAO) ScopedProjects(_ context.Context, _ model.Principal, s store.ProjectScope, _ store.Page) (store.ProjectPage, error) {
	d.scope = s
	return d.page, d.pageErr
}

type accessDAO struct {
	store.ProjectWriteDAO
	access model.ProjectAccess
	err    error
}

func (d accessDAO) ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error) {
	return d.access, d.err
}
func faultCode(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func TestProjectInputValidation(t *testing.T) {
	p := testPrincipal()
	valid := CreateProject{Name: "name", RepoURL: "host:repo", ExpectedUserID: p.UserID}
	if err := ValidateCreate(p, valid); err != nil {
		t.Fatal(err)
	}
	tests := []CreateProject{valid, valid, valid, valid}
	tests[0].ExpectedUserID = testProject
	bad := "bad"
	tests[1].TeamID = &bad
	tests[2].Name = " \x00"
	tests[3].RepoURL = "invalid"
	for _, in := range tests {
		if err := ValidateCreate(p, in); err == nil {
			t.Fatalf("accepted %#v", in)
		}
	}
	if _, err := ValidateRead(model.Principal{}, testProject); err == nil {
		t.Fatal("accepted missing principal")
	}
	if _, err := ValidateRead(p, "bad"); err == nil {
		t.Fatal("accepted invalid id")
	}
	if err := RequireProjectAdmin(model.ProjectAccess{Role: model.ProjectMemberRole}); err == nil {
		t.Fatal("accepted non-admin")
	}
	if err := RequireProjectAdmin(model.ProjectAccess{Role: model.ProjectAdmin}); err != nil {
		t.Fatal(err)
	}
}

func TestProjectCreationAdmissionBoundaries(t *testing.T) {
	p := testPrincipal()
	input := CreateProject{Name: strings.Repeat("😀", 256), RepoURL: "host:repo", ExpectedUserID: p.UserID}
	if err := ValidateCreate(p, input); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{strings.Repeat("a", 257), strings.Repeat("😀", 256) + "a"} {
		input.Name = name
		faultCode(t, ValidateCreateFields(p, input), "invalid_input")
		_, _, err := Create(context.Background(), nil, p.UserID, testProject, input)
		faultCode(t, err, "invalid_input")
	}
	input.Name = "project"
	input.RepoURL = "https://example.com/" + strings.Repeat("x", MaxRepoURLBytes-len("https://example.com/"))
	if err := ValidateCreate(p, input); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRepositoryMatch(input.RepoURL); err != nil {
		t.Fatal(err)
	}
	input.RepoURL += "x"
	faultCode(t, ValidateCreate(p, input), "invalid_input")
	faultCode(t, ValidateCreateFields(p, input), "invalid_input")
	_, _, err := Create(context.Background(), nil, p.UserID, testProject, input)
	faultCode(t, err, "invalid_input")
	_, err = NewRepositoryMatch(input.RepoURL)
	faultCode(t, err, "invalid_input")
}
func TestProjectReadAuthorizationAndFailures(t *testing.T) {
	ctx := context.Background()
	p := testPrincipal()
	d := &readProjectDAO{project: model.Project{ID: testProject}, access: model.ProjectAccess{Role: model.ProjectAdmin}}
	project, access, err := Get(ctx, d, p, testProject)
	if err != nil || project.ID != testProject || access.Role != model.ProjectAdmin {
		t.Fatalf("get: %+v %+v %v", project, access, err)
	}
	if _, err = RequireProjectRead(ctx, d, model.Principal{}, testProject); err == nil {
		t.Fatal("missing actor")
	}
	d.accessErr = model.ErrNotFound
	_, _, err = Get(ctx, d, p, testProject)
	faultCode(t, err, "not_found")
	d.accessErr = nil
	d.projectErr = model.ErrNotFound
	_, _, err = Get(ctx, d, p, testProject)
	faultCode(t, err, "not_found")
	dbErr := errors.New("database failure")
	d.accessErr = dbErr
	if _, err = RequireProjectRead(ctx, d, p, testProject); !errors.Is(err, dbErr) {
		t.Fatal(err)
	}
	if _, err = RequireProjectWrite(ctx, accessDAO{}, model.Principal{}); err == nil {
		t.Fatal("missing actor")
	}
	if _, err = RequireProjectWrite(ctx, accessDAO{err: model.ErrNotFound}, p); err == nil {
		t.Fatal("missing project")
	}
	if _, err = RequireProjectWrite(ctx, accessDAO{access: model.ProjectAccess{Role: model.ProjectAdmin}}, p); err != nil {
		t.Fatal(err)
	}
}
func TestProjectScopedListAndCursor(t *testing.T) {
	ctx := context.Background()
	p := testPrincipal()
	team := testTeam
	requests := []struct {
		req  ProjectListRequest
		kind store.ProjectScopeKind
	}{{ProjectListRequest{Page: model.PageRequest{Limit: 2}}, store.ProjectScopeAll}, {ProjectListRequest{Page: model.PageRequest{Limit: 2}, TeamID: &team}, store.ProjectScopeTeam}, {ProjectListRequest{Page: model.PageRequest{Limit: 2}, Shared: true}, store.ProjectScopeShared}}
	d := &readProjectDAO{page: store.ProjectPage{Items: []model.Project{{ID: testProject, CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}}, HasMore: true}}
	for _, tc := range requests {
		if err := ValidateList(p, tc.req); err != nil {
			t.Fatal(err)
		}
		page, err := ReadList(ctx, d, p, tc.req)
		if err != nil || d.scope.Kind != tc.kind {
			t.Fatalf("scope: %+v %v", d.scope, err)
		}
		result, err := FinishList(p, tc.req, page)
		if err != nil || result.NextCursor == nil {
			t.Fatalf("cursor: %+v %v", result, err)
		}
	}
	invalid := ProjectListRequest{Page: model.PageRequest{Limit: 2}, TeamID: &team, Shared: true}
	if err := ValidateList(p, invalid); err == nil {
		t.Fatal("accepted conflicting scope")
	}
	invalid.Shared = false
	bad := "bad"
	invalid.TeamID = &bad
	if err := ValidateList(p, invalid); err == nil {
		t.Fatal("accepted invalid team")
	}
	if err := ValidateList(model.Principal{}, requests[0].req); err == nil {
		t.Fatal("accepted missing actor")
	}
	if _, err := ReadList(ctx, d, p, invalid); err == nil {
		t.Fatal("accepted invalid scope")
	}
	d.pageErr = model.ErrNotFound
	_, err := ReadList(ctx, d, p, requests[1].req)
	faultCode(t, err, "not_found")
	if _, err = FinishList(p, invalid, store.ProjectPage{}); err == nil {
		t.Fatal("accepted invalid scope")
	}
	d.page.Items[0].CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	_, err = FinishList(p, requests[0].req, d.page)
	if err == nil || !strings.Contains(err.Error(), "encode project cursor") {
		t.Fatal(err)
	}
}

type failedCreationDAO struct {
	*creationDAO
	stage   string
	failure error
}

func (d failedCreationDAO) CreationPersonalTeam(ctx context.Context, lock bool) (store.PersonalTeamFacts, error) {
	if d.stage == "personal" {
		return store.PersonalTeamFacts{}, d.failure
	}
	return d.creationDAO.CreationPersonalTeam(ctx, lock)
}
func (d failedCreationDAO) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	if d.stage == "team" {
		return store.ProjectCreationTeam{}, d.failure
	}
	return d.creationDAO.LockCreationTeam(ctx, id)
}
func (d failedCreationDAO) CreationTeamMember(ctx context.Context, id string) (bool, error) {
	if d.stage == "member" {
		return false, d.failure
	}
	return d.creationDAO.CreationTeamMember(ctx, id)
}
func TestProjectCreationPropagatesAdmissionFailures(t *testing.T) {
	failure := errors.New("database failure")
	team := testTeam
	owner := testUser
	for _, tc := range []struct {
		name  string
		input CreateProject
		dao   creationDAO
		stage string
	}{
		{"personal lock", CreateProject{}, creationDAO{}, "personal"},
		{"target lock", CreateProject{TeamID: &team}, creationDAO{}, "team"},
		{"target personal facts", CreateProject{TeamID: &team}, creationDAO{target: store.ProjectCreationTeam{ID: team, PersonalUserID: &owner}}, "personal"},
		{"membership", CreateProject{TeamID: &team}, creationDAO{target: store.ProjectCreationTeam{ID: team}}, "member"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := Create(context.Background(), failedCreationDAO{&tc.dao, tc.stage, failure}, owner, testProject, tc.input)
			if !errors.Is(err, failure) {
				t.Fatalf("lost error %v", err)
			}
			for _, call := range tc.dao.calls {
				if strings.HasPrefix(call, "insert ") {
					t.Fatal("insert after failed admission")
				}
			}
		})
	}
}
