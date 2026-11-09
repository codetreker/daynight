package team_test

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func teamTransaction(t *testing.T) pgx.Tx {
	t.Helper()
	database, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	tx, err := database.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}
func execute(t *testing.T, tx pgx.Tx, sql string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func addUser(t *testing.T, tx pgx.Tx, name string) string {
	t.Helper()
	id := uuid.NewString()
	execute(t, tx, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,$3,statement_timestamp(),statement_timestamp())`, id, id, name)
	return id
}
func createTeam(t *testing.T, tx pgx.Tx, user, name string) model.Team {
	t.Helper()
	item, err := team.NewCreation(tx, user).InsertTeam(t.Context(), uuid.NewString(), name)
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func TestTeamDAOReadsMembershipVersionsAndPagination(t *testing.T) {
	tx := teamTransaction(t)
	ctx := t.Context()
	owner := addUser(t, tx, "Owner")
	guest := addUser(t, tx, "Guest")
	first := createTeam(t, tx, owner, "Alpha")
	second := createTeam(t, tx, owner, "Second long name")
	execute(t, tx, `UPDATE teams SET created_at='2026-01-01' WHERE id=$1`, first.ID)
	execute(t, tx, `UPDATE teams SET created_at='2026-01-02' WHERE id=$1`, second.ID)
	reader := team.NewReader(tx)
	writer := team.NewWriter(tx, first.ID)
	if err := reader.TeamAccess(ctx, owner, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Team(ctx, guest, first.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("nonmember read: %v", err)
	}
	got, err := writer.Team(ctx, owner)
	if err != nil || got.Kind != "ordinary" || got.Membership.Role != model.ProjectAdmin {
		t.Fatalf("Team: %+v %v", got, err)
	}
	got, err = writer.Rename(ctx, owner, "Renamed")
	if err != nil || *got.Name != "Renamed" || got.Version != first.Version+1 || got.UpdatedAt.Before(first.UpdatedAt) {
		t.Fatalf("rename: %+v %v", got, err)
	}
	page, err := reader.Teams(ctx, owner, store.Page{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != first.ID || !page.HasMore {
		t.Fatalf("first page: %+v %v", page, err)
	}
	after := &store.Position{CreatedAt: page.Items[0].CreatedAt, ID: first.ID}
	page, err = reader.Teams(ctx, owner, store.Page{Limit: 1, After: after})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != second.ID || page.HasMore {
		t.Fatalf("last page: %+v %v", page, err)
	}
	member, err := writer.AddInvitedMember(ctx, guest)
	if err != nil || member.Role != model.ProjectMemberRole {
		t.Fatalf("add: %+v %v", member, err)
	}
	originalVersion := member.Version
	member, err = writer.SetMemberRole(ctx, guest, model.ProjectAdmin)
	if err != nil || member.Version <= originalVersion || member.Role != model.ProjectAdmin {
		t.Fatalf("role: %+v %v", member, err)
	}
	locked, err := writer.Member(ctx, guest)
	if err != nil || locked.Version != member.Version {
		t.Fatalf("locked member: %+v %v", locked, err)
	}
	count, err := writer.AdminCount(ctx)
	if err != nil || count != 2 {
		t.Fatalf("admins: %d %v", count, err)
	}
	execute(t, tx, `UPDATE team_members SET created_at='2026-01-01' WHERE team_id=$1`, first.ID)
	members, err := reader.TeamMembers(ctx, first.ID)
	if err != nil || len(members) != 2 {
		t.Fatalf("members: %+v %v", members, err)
	}
	mp, err := reader.TeamMembersPage(ctx, first.ID, store.Page{Limit: 1})
	if err != nil || len(mp.Items) != 1 || !mp.HasMore {
		t.Fatalf("member page: %+v %v", mp, err)
	}
	paged := append([]model.TeamMemberProfile{}, mp.Items...)
	position := &store.Position{CreatedAt: mp.Items[0].Membership.CreatedAt, ID: mp.Items[0].Membership.UserID}
	mp, err = reader.TeamMembersPage(ctx, first.ID, store.Page{Limit: 2, After: position})
	if err != nil || len(mp.Items) != 1 || mp.HasMore {
		t.Fatalf("member continuation: %+v %v", mp, err)
	}
	paged = append(paged, mp.Items...)
	if !reflect.DeepEqual(paged, members) {
		t.Fatalf("equal-timestamp member pages differ from full directory: paged %#v full %#v", paged, members)
	}

	if err := writer.RemoveMember(ctx, guest); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Member(ctx, guest); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("removed membership: %v", err)
	}
	has, err := writer.HasProjects(ctx)
	if err != nil || has {
		t.Fatalf("empty ownership: %v %v", has, err)
	}
	projectID := uuid.NewString()
	execute(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','host:repo')`, projectID)
	execute(t, tx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, projectID, first.ID)
	has, err = writer.HasProjects(ctx)
	if err != nil || !has {
		t.Fatalf("ownership: %v %v", has, err)
	}
	if err := writer.Delete(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Team(ctx, owner, first.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted Team: %v", err)
	}
}

func TestTeamInvitationDAOLifecycleAndTokenPrivacy(t *testing.T) {
	tx := teamTransaction(t)
	ctx := t.Context()
	owner := addUser(t, tx, "Owner")
	guest := addUser(t, tx, "Guest")
	item := createTeam(t, tx, owner, "Invitations")
	writer := team.NewWriter(tx, item.ID)
	reader := team.NewReader(tx)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	invitations := make([]model.TeamInvitation, 3)
	for index := range invitations {
		invitations[index] = model.TeamInvitation{ID: uuid.NewString(), CreatedBy: owner, TokenHash: bytes.Repeat([]byte{byte(index + 1)}, 32), CreatedAt: now.Add(time.Duration(index) * time.Second), ExpiresAt: now.Add(time.Hour)}
		if err := writer.CreateInvitation(ctx, invitations[index]); err != nil {
			t.Fatal(err)
		}
	}
	got, err := reader.TeamInvitation(ctx, invitations[0].TokenHash)
	if err != nil || got.ID != invitations[0].ID || !bytes.Equal(got.TokenHash, invitations[0].TokenHash) {
		t.Fatalf("token inspection: %+v %v", got, err)
	}
	got, err = writer.LockInvitation(ctx, invitations[0].TokenHash)
	if err != nil || got.TeamID != item.ID {
		t.Fatalf("lock: %+v %v", got, err)
	}
	ref, err := reader.InvitationTeam(ctx, item.ID)
	if err != nil || ref.Kind != "ordinary" || *ref.Name != "Invitations" {
		t.Fatalf("ref: %+v %v", ref, err)
	}
	ref, err = writer.InvitationTeam(ctx)
	if err != nil || ref.ID != item.ID {
		t.Fatalf("writer ref: %+v %v", ref, err)
	}
	member, err := reader.InvitationTeamMember(ctx, item.ID, owner)
	if err != nil || member.Role != model.ProjectAdmin {
		t.Fatalf("member: %+v %v", member, err)
	}
	member, err = writer.AddInvitedMember(ctx, guest)
	if err != nil || member.UserID != guest {
		t.Fatalf("invited: %+v %v", member, err)
	}
	page, err := reader.TeamInvitationPage(ctx, item.ID, now, store.Page{Limit: 1})
	if err != nil || len(page.Items) != 1 || !page.HasMore || page.Items[0].TokenHash != nil {
		t.Fatalf("page: %+v %v", page, err)
	}
	page, err = reader.TeamInvitationPage(ctx, item.ID, now, store.Page{Limit: 3, After: &store.Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].ID}})
	if err != nil || len(page.Items) != 2 || page.HasMore {
		t.Fatalf("continuation: %+v %v", page, err)
	}
	changed, err := writer.RevokeInvitation(ctx, invitations[0].ID, now)
	if err != nil || !changed {
		t.Fatalf("revoke: %v %v", changed, err)
	}
	changed, err = writer.RevokeInvitation(ctx, invitations[0].ID, now)
	if err != nil || changed {
		t.Fatalf("repeated revoke: %v %v", changed, err)
	}
	if err := writer.ConsumeInvitation(ctx, invitations[1].ID, guest, now); err != nil {
		t.Fatal(err)
	}
	active, err := reader.TeamInvitations(ctx, item.ID, now)
	if err != nil || len(active) != 1 || active[0].ID != invitations[2].ID || active[0].TokenHash != nil {
		t.Fatalf("active privacy: %+v %v", active, err)
	}
	newer := model.TeamInvitation{ID: uuid.NewString(), CreatedBy: owner, TokenHash: bytes.Repeat([]byte{9}, 32), CreatedAt: now.Add(2 * time.Hour), ExpiresAt: now.Add(3 * time.Hour)}
	if err := writer.CreateInvitation(ctx, newer); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.TeamInvitation(ctx, invitations[2].TokenHash); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("expired invitation cleanup: %v", err)
	}
}

func TestPersonalTeamDAO(t *testing.T) {
	tx := teamTransaction(t)
	ctx := t.Context()
	owner := addUser(t, tx, "Personal")
	id := uuid.NewString()
	execute(t, tx, `INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, id, owner)
	execute(t, tx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, id, owner)
	reader := team.NewReader(tx)
	got, err := reader.Team(ctx, owner, id)
	if err != nil || got.Kind != "personal" || got.Name != nil {
		t.Fatalf("personal: %+v %v", got, err)
	}
	if err := reader.TeamAccess(ctx, owner, id); err != nil {
		t.Fatal(err)
	}
	if ref, err := reader.InvitationTeam(ctx, id); err != nil || ref.Kind != "personal" {
		t.Fatalf("personal reference: %+v %v", ref, err)
	}
}

func TestTeamDAOClosedTransactionPreservesCauses(t *testing.T) {
	tx := teamTransaction(t)
	ctx := t.Context()
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	reader := team.NewReader(tx)
	writer := team.NewWriter(tx, id)
	checks := map[string]func() error{
		"create":            func() error { _, err := team.NewCreation(tx, id).InsertTeam(ctx, id, "Name"); return err },
		"Team":              func() error { _, err := reader.Team(ctx, id, id); return err },
		"access":            func() error { return reader.TeamAccess(ctx, id, id) },
		"Teams":             func() error { _, err := reader.Teams(ctx, id, store.Page{Limit: 1}); return err },
		"rename":            func() error { _, err := writer.Rename(ctx, id, "Name"); return err },
		"ownership":         func() error { _, err := writer.HasProjects(ctx); return err },
		"delete":            func() error { return writer.Delete(ctx) },
		"members":           func() error { _, err := reader.TeamMembers(ctx, id); return err },
		"member page":       func() error { _, err := reader.TeamMembersPage(ctx, id, store.Page{Limit: 1}); return err },
		"member":            func() error { _, err := writer.Member(ctx, id); return err },
		"admins":            func() error { _, err := writer.AdminCount(ctx); return err },
		"role":              func() error { _, err := writer.SetMemberRole(ctx, id, model.ProjectMemberRole); return err },
		"remove":            func() error { return writer.RemoveMember(ctx, id) },
		"invitation":        func() error { _, err := reader.TeamInvitation(ctx, nil); return err },
		"lock invitation":   func() error { _, err := writer.LockInvitation(ctx, nil); return err },
		"create invitation": func() error { return writer.CreateInvitation(ctx, model.TeamInvitation{}) },
		"invitations":       func() error { _, err := reader.TeamInvitations(ctx, id, time.Now()); return err },
		"invitation page": func() error {
			_, err := reader.TeamInvitationPage(ctx, id, time.Now(), store.Page{Limit: 1})
			return err
		},
		"revoke":            func() error { _, err := writer.RevokeInvitation(ctx, id, time.Now()); return err },
		"consume":           func() error { return writer.ConsumeInvitation(ctx, id, id, time.Now()) },
		"reference":         func() error { _, err := reader.InvitationTeam(ctx, id); return err },
		"invitation member": func() error { _, err := reader.InvitationTeamMember(ctx, id, id); return err },
		"add member":        func() error { _, err := writer.AddInvitedMember(ctx, id); return err },
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); !errors.Is(err, pgx.ErrTxClosed) {
				t.Fatalf("cause lost: %v", err)
			}
		})
	}
}
