package project

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type readContractDAO struct {
	store.ProjectReader
	access  func(context.Context, model.Principal, string) (model.ProjectAccess, error)
	project func(context.Context, string) (model.Project, error)
	page    func(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error)
}

func (d readContractDAO) ProjectAccess(c context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	return d.access(c, p, id)
}
func (d readContractDAO) Project(c context.Context, id string) (model.Project, error) {
	return d.project(c, id)
}
func (d readContractDAO) ScopedProjects(c context.Context, p model.Principal, s store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	return d.page(c, p, s, page)
}

func TestProjectReadPreservesCompleteAccessAndAuthority(t *testing.T) {
	project := contractProject("a8888888-8888-4888-8888-888888888888", "Access projection", "https://example.test/access.git", "b9999999-9999-4999-8999-999999999999")
	project.Ownership.Version = 9007199254740993
	admin := contractPrincipal()
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	outsider := model.Principal{UserID: "f6666666-6666-4666-8666-666666666666", CredentialID: "a7777777-7777-4777-8777-777777777777", Kind: model.PATCredential}
	failure := errors.New("database failure")
	for _, tc := range []struct {
		name    string
		p       model.Principal
		role    model.ProjectRole
		version int64
		err     error
	}{
		{"admin", admin, model.ProjectAdmin, 9007199254740993, nil},
		{"member", member, model.ProjectMemberRole, 1, nil},
		{"outsider", outsider, "", 0, model.ErrNotFound},
		{"access failure", admin, "", 0, failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			names := []string{"access"}
			if tc.err == nil {
				names = append(names, "project")
			}
			take := contractPlan(t, ctx, names...)
			wantAccess := contractAccess(tc.p, project)
			wantAccess.Role, wantAccess.DirectGrant.Role, wantAccess.DirectGrant.Version = tc.role, tc.role, tc.version
			if tc.role != model.ProjectAdmin {
				wantAccess.TeamRole = nil
				wantAccess.CanTransfer = false
			}
			dao := readContractDAO{access: func(c context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
				take(c, "access")
				contractEqual(t, p, tc.p)
				contractEqual(t, id, project.ID)
				if tc.err != nil {
					return model.ProjectAccess{}, tc.err
				}
				return contractCloneAccess(wantAccess), nil
			}, project: func(c context.Context, id string) (model.Project, error) {
				take(c, "project")
				contractEqual(t, id, project.ID)
				return project, nil
			}}
			got, access, err := Get(ctx, dao, tc.p, project.ID)
			if tc.err != nil {
				if tc.err == model.ErrNotFound {
					faultCode(t, err, "not_found")
				}
				if !errors.Is(err, tc.err) {
					t.Fatalf("lost access error: %v", err)
				}
				contractEqual(t, got, model.Project{})
				contractEqual(t, access, model.ProjectAccess{})
			} else {
				if err != nil {
					t.Fatal(err)
				}
				contractEqual(t, got, project)
				contractEqual(t, access, wantAccess)
			}
		})
	}
}

func TestProjectScopedCursorBindsActorScopeAndExactPosition(t *testing.T) {
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"}
	for _, tc := range []struct {
		name  string
		scope store.ProjectScope
		rows  []model.Project
	}{
		{"all", store.ProjectScope{Kind: store.ProjectScopeAll}, []model.Project{contractProject(ids[0], "same time", "https://github.com/example/repo", contractPersonalTeam), contractProject(ids[1], "same time", "https://github.com/example/repo", contractPersonalTeam), contractProject(ids[2], "same time", "https://github.com/example/repo", contractPersonalTeam)}},
		{"team", store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: contractPersonalTeam}, []model.Project{contractProject(ids[0], "project", "https://github.com/example/repo", contractPersonalTeam), contractProject(ids[1], "project", "https://github.com/example/repo", contractPersonalTeam)}},
		{"shared", store.ProjectScope{Kind: store.ProjectScopeShared}, []model.Project{contractProject(ids[0], "First shared", "https://example.com/first.git", contractPersonalTeam), contractProject(ids[1], "Second shared", "https://example.com/second.git", contractPersonalTeam)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := contractPrincipal()
			if tc.name == "shared" {
				p.UserID = "00000000-0000-4000-8000-000000000040"
			}
			ctx := t.Context()
			if tc.name == "shared" {
				tc.rows[1].CreatedAt = tc.rows[0].CreatedAt.Add(time.Second)
				tc.rows[1].UpdatedAt = tc.rows[1].CreatedAt
			}
			req := ProjectListRequest{Page: model.PageRequest{Limit: 1}}
			if tc.scope.Kind == store.ProjectScopeTeam {
				team := tc.scope.TeamID
				req.TeamID = &team
			}
			req.Shared = tc.scope.Kind == store.ProjectScopeShared
			var after *store.Position
			for i, row := range tc.rows {
				take := contractPlan(t, ctx, "page")
				wantPage := store.Page{Limit: 1, After: contractClonePointer(after)}
				dao := readContractDAO{page: func(c context.Context, actor model.Principal, s store.ProjectScope, page store.Page) (store.ProjectPage, error) {
					take(c, "page")
					contractEqual(t, actor, p)
					contractEqual(t, s, tc.scope)
					contractEqual(t, page, wantPage)
					return store.ProjectPage{Items: slices.Clone([]model.Project{row}), HasMore: i < len(tc.rows)-1}, nil
				}}
				facts, err := ReadList(ctx, dao, p, req)
				if err != nil {
					t.Fatal(err)
				}
				result, err := FinishList(p, req, facts)
				if err != nil {
					t.Fatal(err)
				}
				contractEqual(t, result.Items, []model.Project{row})
				if (result.NextCursor != nil) != (i < len(tc.rows)-1) {
					t.Fatalf("page %d cursor=%v", i, result.NextCursor)
				}
				if result.NextCursor != nil {
					cursor := *result.NextCursor
					reject := func(actor model.Principal, bad ProjectListRequest) {
						t.Helper()
						noCalls := contractPlan(t, ctx)
						blocked := readContractDAO{page: func(c context.Context, _ model.Principal, _ store.ProjectScope, _ store.Page) (store.ProjectPage, error) {
							noCalls(c, "page")
							return store.ProjectPage{}, nil
						}}
						_, err := ReadList(ctx, blocked, actor, bad)
						faultCode(t, err, "invalid_input")
					}
					bad := req
					if tc.scope.Kind == store.ProjectScopeAll {
						data, err := base64.RawURLEncoding.DecodeString(cursor)
						if err != nil {
							t.Fatal(err)
						}
						var raw map[string]any
						if err = json.Unmarshal(data, &raw); err != nil {
							t.Fatal(err)
						}
						raw["kind"] = "tasks"
						data, err = json.Marshal(raw)
						if err != nil {
							t.Fatal(err)
						}
						wrongKind := base64.RawURLEncoding.EncodeToString(data)
						bad = req
						bad.Page.Cursor = &wrongKind
						reject(p, bad)
					}
					if i == 0 {
						bad = req
						bad.Page.Cursor = &cursor
						switch tc.scope.Kind {
						case store.ProjectScopeAll:
							team := contractPersonalTeam
							bad.TeamID = &team
							reject(p, bad)
						case store.ProjectScopeTeam:
							bad.TeamID = nil
							reject(p, bad)
							bad.Shared = true
							reject(p, bad)
							bad.Shared = false
							other := "00000000-0000-4000-8000-000000000099"
							bad.TeamID = &other
							reject(p, bad)
						case store.ProjectScopeShared:
							bad.Shared = false
							reject(p, bad)
							team := contractPersonalTeam
							bad.TeamID = &team
							reject(p, bad)
							other := p
							other.UserID = "00000000-0000-4000-8000-000000000041"
							bad = req
							bad.Page.Cursor = &cursor
							reject(other, bad)
						}
					}
				}
				after = &store.Position{ID: row.ID, CreatedAt: row.CreatedAt}
				req.Page.Cursor = result.NextCursor
			}
		})
	}
}
