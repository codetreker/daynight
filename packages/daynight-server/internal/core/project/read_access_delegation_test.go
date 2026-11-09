package project

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type attachmentReadAccessOracle struct {
	t         *testing.T
	context   context.Context
	principal model.Principal
	project   string
	access    model.ProjectAccess
	calls     int
}

func (d *attachmentReadAccessOracle) ProjectAccess(ctx context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
	d.t.Helper()
	d.calls++
	if ctx != d.context || principal != d.principal || project != d.project || d.calls != 1 {
		d.t.Fatalf("Attachment read delegation: context=%v principal=%#v project=%q calls=%d", ctx, principal, project, d.calls)
	}
	return d.access, nil
}

func TestAttachmentProjectReadDelegationPreservesAuthorityAndCompleteAccess(t *testing.T) {
	ctx := t.Context()
	principal := model.Principal{Kind: model.SessionCredential, UserID: "ef000000-0000-4000-8000-000000000001", CredentialID: "ef000000-0000-4000-8000-000000000002"}
	project := "cd000000-0000-4000-8000-000000000001"
	role := model.ProjectAdmin
	team := "ef000000-0000-4000-8000-000000000003"
	access := model.ProjectAccess{ProjectID: project, UserID: principal.UserID, Role: role, TeamRole: &role, OwnerTeam: model.TeamRef{ID: team, Kind: "personal"}, Ownership: model.ProjectOwnership{TeamID: team, Version: 1}, CanTransfer: true}
	dao := &attachmentReadAccessOracle{t: t, context: ctx, principal: principal, project: project, access: access}
	got, err := RequireProjectRead(ctx, dao, principal, project)
	if err != nil || !reflect.DeepEqual(got, access) || dao.calls != 1 {
		t.Fatalf("Attachment Project access: got=%#v error=%v calls=%d; want=%#v", got, err, dao.calls, access)
	}
}
