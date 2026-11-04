package service

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
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

func TestTransferInvalidInputsAndCancellation(t *testing.T) {
	projects, db, _, actor := projectService(t)
	ctx := context.Background()
	project, err := projects.Create(ctx, actor, CreateProject{Name: "Validation", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	valid := TransferInput{Ownership: project.Ownership, TargetTeam: TeamVersion{ID: project.Ownership.TeamID, Version: 1}, ExpectedUserID: actor.UserID}
	_, err = projects.TransferPreview(ctx, core.Principal{}, project.ID, valid.TargetTeam.ID)
	transferFault(t, err, "unauthenticated")
	_, err = projects.TransferPreview(ctx, actor, "bad", valid.TargetTeam.ID)
	transferFault(t, err, "invalid_input")
	_, err = projects.TransferPreview(ctx, actor, project.ID, strings.ToUpper(valid.TargetTeam.ID))
	transferFault(t, err, "invalid_input")
	_, err = projects.Transfer(ctx, core.Principal{}, project.ID, valid)
	transferFault(t, err, "unauthenticated")
	_, err = projects.Transfer(ctx, actor, "bad", valid)
	transferFault(t, err, "invalid_input")
	for _, mutate := range []func(*TransferInput){
		func(input *TransferInput) { input.Ownership.TeamID = "bad" },
		func(input *TransferInput) { input.TargetTeam.ID = "bad" },
		func(input *TransferInput) { input.Ownership.Version = 0 },
		func(input *TransferInput) { input.TargetTeam.Version = 0 },
		func(input *TransferInput) { input.ExpectedUserID = "bad" },
	} {
		input := valid
		mutate(&input)
		_, err := projects.Transfer(ctx, actor, project.ID, input)
		transferFault(t, err, "invalid_input")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = projects.TransferPreview(canceled, actor, project.ID, valid.TargetTeam.ID)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled preview: %v", err)
	}
	_, err = projects.Transfer(canceled, actor, project.ID, valid)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled transfer: %v", err)
	}
	var owner string
	var version int64
	if err := db.Pool.QueryRow(ctx, `SELECT team_id::text,version FROM project_ownership WHERE project_id=$1`, project.ID).Scan(&owner, &version); err != nil || owner != project.Ownership.TeamID || version != project.Ownership.Version {
		t.Fatalf("failed input or cancellation changed ownership: %s %d %v", owner, version, err)
	}
}

func TestTransferUnavailableAndVersionExhaustion(t *testing.T) {
	projects, db, _, actor := projectService(t)
	ctx := context.Background()
	project, err := projects.Create(ctx, actor, CreateProject{Name: "Exhaustion", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	missing := uuid.NewString()
	_, err = projects.TransferPreview(ctx, actor, project.ID, missing)
	transferFault(t, err, "not_found")
	input := TransferInput{Ownership: project.Ownership, TargetTeam: TeamVersion{ID: missing, Version: 1}, ExpectedUserID: actor.UserID}
	_, err = projects.Transfer(ctx, actor, project.ID, input)
	transferFault(t, err, "not_found")
	_, err = projects.TransferPreview(ctx, actor, uuid.NewString(), missing)
	transferFault(t, err, "not_found")
	_, err = projects.Transfer(ctx, actor, uuid.NewString(), input)
	if !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("missing project error: %v", err)
	}
	other := servicePrincipal(t, db)
	target := newTestTeam(t, NewTeams(db), other, "Destination")
	if _, err := db.Pool.Exec(ctx, `UPDATE project_ownership SET version=$2 WHERE project_id=$1`, project.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	input.Ownership.Version = math.MaxInt64
	input.TargetTeam = TeamVersion{ID: target.ID, Version: target.Version}
	_, err = projects.Transfer(ctx, actor, project.ID, input)
	transferFault(t, err, "version_exhausted")
	input.TargetTeam = TeamVersion{ID: project.Ownership.TeamID, Version: 1}
	result, err := projects.Transfer(ctx, actor, project.ID, input)
	if err != nil || result.Changed || result.Ownership.Version != math.MaxInt64 {
		t.Fatalf("verified no-op with exhausted version: %#v %v", result, err)
	}
}

func TestTransferDatabaseFailuresDoNotMasqueradeAsRejection(t *testing.T) {
	projects, db, _, actor := projectService(t)
	ctx := context.Background()
	project, err := projects.Create(ctx, actor, CreateProject{Name: "Database failure", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	input := TransferInput{Ownership: project.Ownership, TargetTeam: TeamVersion{ID: project.Ownership.TeamID, Version: 1}, ExpectedUserID: actor.UserID}
	if _, err := db.Pool.Exec(ctx, `DROP TABLE project_grants`); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error {
			_, err := projects.TransferPreview(ctx, actor, project.ID, input.TargetTeam.ID)
			return err
		},
		func() error { _, err := projects.Transfer(ctx, actor, project.ID, input); return err },
	} {
		err := operation()
		var refusal *Fault
		if err == nil || errors.As(err, &refusal) {
			t.Fatalf("database failure became success or refusal: %v", err)
		}
	}
	var owner string
	var version int64
	if err := db.Pool.QueryRow(ctx, `SELECT team_id::text,version FROM project_ownership WHERE project_id=$1`, project.ID).Scan(&owner, &version); err != nil || owner != project.Ownership.TeamID || version != project.Ownership.Version {
		t.Fatalf("database failure changed ownership: %s %d %v", owner, version, err)
	}
}
