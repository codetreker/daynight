package project

import (
	"errors"
	"reflect"
	"testing"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func transferFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("expected %s: %v", code, err)
	}
}
func transferInput(p coreproject.TransferPreview, actor model.Principal) coreproject.TransferInput {
	return coreproject.TransferInput{Ownership: p.Ownership, TargetTeam: coreproject.TeamVersion{ID: p.TargetTeam.ID, Version: p.TargetTeamVersion}, ExpectedUserID: actor.UserID}
}

func TestTransferSameTeamLeavesProjectUnchanged(t *testing.T) {
	projects, _, _, actor := projectService(t)
	ctx := t.Context()
	project, err := projects.Create(ctx, actor, coreproject.CreateProject{
		Name: "Project", RepoURL: "host:repo", ExpectedUserID: actor.UserID,
	})
	if err != nil {
		t.Fatal(err)
	}
	same, err := projects.TransferPreview(ctx, actor, project.ID, project.Ownership.TeamID)
	if err != nil {
		t.Fatal(err)
	}
	before, err := projects.Get(ctx, actor, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := projects.Transfer(ctx, actor, project.ID, transferInput(same, actor))
	if err != nil || receipt.Changed || receipt.ActorAccess == nil {
		t.Fatalf("same-Team receipt %#v, error %v", receipt, err)
	}
	after, err := projects.Get(ctx, actor, project.ID)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("same-Team transfer changed Project: before %#v, after %#v, error %v", before, after, err)
	}
}
