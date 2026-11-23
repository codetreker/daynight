package project

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestProjectAccessProjectionAndAuthorization(t *testing.T) {
	admin, member, outsider := projectProjectionPrincipal(1), projectProjectionPrincipal(2), projectProjectionPrincipal(3)
	const projectID = "ef000000-0000-4000-8000-000000000001"
	created := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	adminRole := model.ProjectAdmin
	for _, test := range []struct {
		name      string
		principal model.Principal
		role      model.ProjectRole
		teamRole  *model.ProjectRole
		version   int64
	}{
		{"admin", admin, model.ProjectAdmin, &adminRole, 1},
		{"member", member, model.ProjectMemberRole, nil, 9007199254740993},
	} {
		t.Run(test.name, func(t *testing.T) {
			grant := model.ProjectGrant{
				ProjectID: projectID,
				UserID:    test.principal.UserID,
				Role:      test.role,
				Version:   test.version,
				CreatedAt: created,
				UpdatedAt: created.Add(time.Second),
			}
			want := model.ProjectAccess{
				ProjectID:   projectID,
				UserID:      test.principal.UserID,
				Role:        test.role,
				DirectGrant: &grant,
				OwnerTeam:   model.TeamRef{ID: projectProjectionTeam, Kind: "personal"},
				Ownership:   model.ProjectOwnership{TeamID: projectProjectionTeam, Version: 2, UpdatedAt: created.Add(time.Minute)},
				TeamRole:    test.teamRole,
				CanTransfer: test.teamRole != nil,
			}
			given := want
			givenGrant := grant
			given.DirectGrant = &givenGrant
			if test.teamRole != nil {
				givenTeamRole := *test.teamRole
				given.TeamRole = &givenTeamRole
			}
			db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
				{name: "access", args: []any{test.principal, projectID}, result: given},
			})
			access, err := NewProjects(db).Access(t.Context(), test.principal, strings.ToUpper(projectID))
			if err != nil || !reflect.DeepEqual(access, want) {
				t.Fatalf("current actor access: %#v %v, want %#v", access, err, want)
			}
		})
	}
	for _, test := range []struct {
		name      string
		principal model.Principal
		projectID string
	}{
		{"inaccessible project", outsider, projectID},
		{"missing project", admin, "ef000000-0000-4000-8000-000000000099"},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
				{name: "access", args: []any{test.principal, test.projectID}, err: model.ErrNotFound},
			})
			access, err := NewProjects(db).Access(t.Context(), test.principal, test.projectID)
			fault := requireFault(t, err, "not_found")
			if !errors.Is(fault, model.ErrNotFound) || !reflect.DeepEqual(access, model.ProjectAccess{}) {
				t.Fatalf("missing access cause or unexpected actor data: %#v, %v", access, fault)
			}
		})
	}
}
