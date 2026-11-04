package service

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func transferFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("expected %s: %v", code, err)
	}
}
func transferInput(p TransferPreview, actor core.Principal) TransferInput {
	return TransferInput{Ownership: p.Ownership, TargetTeam: TeamVersion{ID: p.TargetTeam.ID, Version: p.TargetTeamVersion}, ExpectedUserID: actor.UserID}
}

func TestTransferAuthorizationVersionsAndReceipts(t *testing.T) {
	projects, db, _, actor := projectService(t)
	ctx := context.Background()
	teams := NewTeams(db)
	other := servicePrincipal(t, db)
	target := newTestTeam(t, teams, other, "Target")
	project, err := projects.Create(ctx, actor, CreateProject{Name: "Project", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := projects.TransferPreview(ctx, actor, project.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if preview.SourceTeam.ID != project.Ownership.TeamID || preview.TargetTeam.ID != target.ID || preview.TargetTeamVersion != 1 || preview.ActorRole == nil || *preview.ActorRole != core.ProjectAdmin {
		t.Fatalf("preview %#v", preview)
	}
	// A Project-only admin cannot transfer. Remove the creator's direct grant so
	// transfer to an unrelated Team demonstrates a real loss of access.
	if _, err = db.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, other.UserID); err != nil {
		t.Fatal(err)
	}
	_, err = projects.TransferPreview(ctx, other, project.ID, target.ID)
	transferFault(t, err, "forbidden")
	_, err = projects.Transfer(ctx, other, project.ID, TransferInput{Ownership: preview.Ownership, TargetTeam: TeamVersion{ID: target.ID, Version: 1}, ExpectedUserID: other.UserID})
	transferFault(t, err, "forbidden")
	if _, err = db.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO project_invitations(id,project_id,created_by,token_hash,created_at,expires_at) VALUES($1,$2,$3,sha256('transfer-test'::bytea),now(),now()+interval '1 day')`, uuid.NewString(), project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	preview, err = projects.TransferPreview(ctx, actor, project.ID, target.ID)
	if err != nil || preview.ActorRole != nil {
		t.Fatalf("preview access %#v %v", preview, err)
	}
	input := transferInput(preview, actor)
	bad := input
	bad.Ownership.Version++
	_, err = projects.Transfer(ctx, actor, project.ID, bad)
	transferFault(t, err, "version_conflict")
	bad = input
	bad.TargetTeam.Version++
	_, err = projects.Transfer(ctx, actor, project.ID, bad)
	transferFault(t, err, "version_conflict")
	bad = input
	bad.ExpectedUserID = other.UserID
	_, err = projects.Transfer(ctx, actor, project.ID, bad)
	transferFault(t, err, "identity_mismatch")
	var grantsBefore, invitesBefore string
	if err = db.Pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY user_id),'[]')::text FROM project_grants g WHERE project_id=$1`, project.ID).Scan(&grantsBefore); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]')::text FROM project_invitations i WHERE project_id=$1`, project.ID).Scan(&invitesBefore); err != nil {
		t.Fatal(err)
	}
	result, err := projects.Transfer(ctx, actor, project.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.ActorAccess != nil || result.Ownership.TeamID != target.ID || result.Ownership.Version != input.Ownership.Version+1 || result.SourceTeam.ID != input.Ownership.TeamID || result.OwnerTeam.ID != target.ID {
		t.Fatalf("receipt %#v", result)
	}
	_, err = projects.Get(ctx, actor, project.ID)
	transferFault(t, err, "not_found")
	var grantsAfter, invitesAfter string
	if err = db.Pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY user_id),'[]')::text FROM project_grants g WHERE project_id=$1`, project.ID).Scan(&grantsAfter); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]')::text FROM project_invitations i WHERE project_id=$1`, project.ID).Scan(&invitesAfter); err != nil {
		t.Fatal(err)
	}
	if grantsBefore != grantsAfter || invitesBefore != invitesAfter {
		t.Fatal("transfer changed grants or invitations")
	}
	// Target administrator transfers it back; the old owner/version cannot be
	// reused after the ownership completes a full ABA cycle.
	back, err := projects.TransferPreview(ctx, other, project.ID, input.Ownership.TeamID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = projects.Transfer(ctx, other, project.ID, transferInput(back, other))
	if err != nil {
		t.Fatal(err)
	}
	_, err = projects.Transfer(ctx, actor, project.ID, input)
	transferFault(t, err, "version_conflict")
	same, err := projects.TransferPreview(ctx, actor, project.ID, input.Ownership.TeamID)
	if err != nil {
		t.Fatal(err)
	}
	before, err := projects.Get(ctx, actor, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	noOp, err := projects.Transfer(ctx, actor, project.ID, transferInput(same, actor))
	if err != nil || noOp.Changed || noOp.ActorAccess == nil {
		t.Fatalf("no-op %#v %v", noOp, err)
	}
	after, err := projects.Get(ctx, actor, project.ID)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("no-op modified project %#v %#v %v", before, after, err)
	}
	stale := transferInput(same, actor)
	stale.TargetTeam.Version++
	_, err = projects.Transfer(ctx, actor, project.ID, stale)
	transferFault(t, err, "version_conflict")
}

func TestTransferValidationBeforeDomainSQL(t *testing.T) {
	_, db, url, actor := projectService(t)
	other := servicePrincipal(t, db)
	var count atomic.Int32
	traced := tracedTasks(t, url, taskQueryAction{match: func(string) bool { count.Add(1); return false }})
	_, err := NewProjects(traced.store).Transfer(context.Background(), actor, uuid.NewString(), TransferInput{ExpectedUserID: other.UserID})
	transferFault(t, err, "identity_mismatch")
	if count.Load() != 0 {
		t.Fatalf("identity mismatch executed %d queries", count.Load())
	}
}
