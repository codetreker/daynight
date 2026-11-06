package project_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type fixture struct {
	db                                            *postgres.Store
	tx                                            pgx.Tx
	owner, member, guest, team, personal, project string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	f := fixture{db: db, tx: tx, owner: uuid.NewString(), member: uuid.NewString(), guest: uuid.NewString(), team: uuid.NewString(), personal: uuid.NewString(), project: uuid.NewString()}
	for _, id := range []string{f.owner, f.member, f.guest} {
		exec(t, tx, `INSERT INTO users(id,uniauth_id,name,email,avatar_url,created_at,updated_at) VALUES($1,$2,'Name','mail@example.com','https://example.com/avatar',now(),now())`, id, id)
	}
	exec(t, tx, `INSERT INTO teams(id,name) VALUES($1,'Team')`, f.team)
	exec(t, tx, `INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, f.personal, f.owner)
	exec(t, tx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member'),($4,$2,'admin')`, f.team, f.owner, f.member, f.personal)
	_, _, err = project.NewCreation(tx, f.owner).InsertProject(t.Context(), f.project, "Project", "host:repo", f.team)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func exec(t *testing.T, tx pgx.Tx, sql string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func checkError(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v; want %v", err, want)
	}
}
func principal(id string) model.Principal { return model.Principal{UserID: id} }

func TestProjectCreationAndSettingsPersist(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	creator := project.NewCreation(f.tx, f.owner)
	for _, lock := range []bool{false, true} {
		facts, err := creator.CreationPersonalTeam(ctx, lock)
		if err != nil || facts.ID != f.personal || facts.MemberCount != 1 || facts.OwnerAdminCount != 1 {
			t.Fatalf("personal facts = %+v, %v", facts, err)
		}
	}
	empty, err := project.NewCreation(f.tx, f.guest).CreationPersonalTeam(ctx, false)
	if err != nil || empty.ID != "" {
		t.Fatalf("missing personal team = %+v, %v", empty, err)
	}
	team, err := creator.LockCreationTeam(ctx, f.personal)
	if err != nil || team.ID != f.personal || team.PersonalUserID == nil || *team.PersonalUserID != f.owner {
		t.Fatalf("creation team = %+v, %v", team, err)
	}
	for _, id := range []string{f.owner, f.guest} {
		found, err := project.NewCreation(f.tx, id).CreationTeamMember(ctx, f.team)
		if err != nil || found != (id == f.owner) {
			t.Fatalf("membership = %v, %v", found, err)
		}
	}
	_, err = creator.LockCreationTeam(ctx, uuid.NewString())
	checkError(t, err, model.ErrNotFound)
	writer := project.NewWriter(f.tx, f.project)
	before, err := writer.Project(ctx)
	if err != nil {
		t.Fatal(err)
	}
	after, err := writer.UpdateProjectSettings(ctx, 37)
	if err != nil || after.Settings.Version != before.Settings.Version+1 || after.Settings.ExecutionWarningMinutes != 37 {
		t.Fatalf("settings = %+v, %v", after, err)
	}
	var oldEpoch, newEpoch string
	if err := f.tx.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, f.project).Scan(&oldEpoch); err != nil {
		t.Fatal(err)
	}
	if err := writer.InvalidateTaskCache(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.tx.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, f.project).Scan(&newEpoch); err != nil || oldEpoch == newEpoch {
		t.Fatalf("epoch unchanged: %q %q %v", oldEpoch, newEpoch, err)
	}
	if err := f.tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	readTx, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer readTx.Rollback(context.Background())
	reader := project.NewReader(readTx)
	saved, err := reader.Project(ctx, f.project)
	if err != nil || saved != after || saved.Ownership.TeamID != f.team || saved.Name != "Project" || saved.RepoURL != "host:repo" {
		t.Fatalf("saved = %+v, %v", saved, err)
	}
	access, err := reader.ProjectAccess(ctx, principal(f.owner), f.project)
	if err != nil || access.DirectGrant == nil || access.Role != model.ProjectAdmin || !access.CanTransfer {
		t.Fatalf("created access = %+v, %v", access, err)
	}
	_, err = reader.Project(ctx, uuid.NewString())
	checkError(t, err, model.ErrNotFound)
}

func TestProjectGrantsParticipantsAndAuthorization(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	w := project.NewWriter(f.tx, f.project)
	r := project.NewReader(f.tx)
	grant, err := w.CreateGrant(ctx, f.member, model.ProjectAdmin)
	if err != nil || grant.Role != model.ProjectAdmin || grant.Version <= 0 {
		t.Fatalf("grant = %+v, %v", grant, err)
	}
	changed, err := w.SetMemberRole(ctx, f.member, model.ProjectMemberRole)
	if err != nil || changed.Grant.Version <= grant.Version || changed.Grant.Role != model.ProjectMemberRole {
		t.Fatalf("changed = %+v, %v", changed, err)
	}
	direct, err := r.DirectProjectMember(ctx, f.member, f.project)
	if err != nil || !reflect.DeepEqual(direct, changed) || direct.Name == nil || *direct.Name != "Name" {
		t.Fatalf("member = %+v, %v", direct, err)
	}
	invited, err := w.AddInvitedMember(ctx, f.guest)
	if err != nil || invited.Grant.UserID != f.guest || invited.Grant.Role != model.ProjectMemberRole {
		t.Fatalf("invited = %+v, %v", invited, err)
	}
	participants, err := r.ProjectParticipants(ctx, f.project)
	if err != nil || len(participants) != 3 {
		t.Fatalf("participants = %+v, %v", participants, err)
	}
	for _, p := range participants {
		if p.Profile.Email == nil || p.DirectGrant == nil || p.EffectiveRole != p.DirectGrant.Role {
			t.Fatalf("participant = %+v", p)
		}
		if (p.InheritedFrom != nil) != (p.UserID != f.guest) {
			t.Fatalf("inheritance = %+v", p)
		}
		if p.InheritedFrom != nil && p.InheritedFrom.Team.Kind != "ordinary" {
			t.Fatalf("team = %+v", p.InheritedFrom)
		}
	}
	for _, user := range []string{f.owner, f.member, f.guest} {
		a, err := w.ProjectAccess(ctx, principal(user))
		if err != nil {
			t.Fatal(err)
		}
		locked, err := project.NewThreadDAO(f.tx).LockProjectAuthorization(ctx, principal(user), f.project)
		if err != nil || !reflect.DeepEqual(a, locked) {
			t.Fatalf("locked = %+v; access = %+v; error = %v", locked, a, err)
		}
	}
	if err := w.RemoveMember(ctx, f.guest); err != nil {
		t.Fatal(err)
	}
	_, err = w.DirectGrant(ctx, f.guest)
	checkError(t, err, model.ErrNotFound)
	_, err = r.ProjectAccess(ctx, principal(f.guest), f.project)
	checkError(t, err, model.ErrNotFound)
	_, err = project.NewThreadDAO(f.tx).LockProjectAuthorization(ctx, principal(f.guest), f.project)
	checkError(t, err, model.ErrNotFound)
	if err := w.RemoveMember(ctx, f.member); err != nil {
		t.Fatal(err)
	}
	inherited, err := r.ProjectAccess(ctx, principal(f.member), f.project)
	if err != nil || inherited.DirectGrant != nil || inherited.TeamRole == nil || inherited.Role != model.ProjectMemberRole {
		t.Fatalf("inherited = %+v, %v", inherited, err)
	}
	_, err = w.AddInvitedMember(ctx, uuid.NewString())
	checkError(t, err, model.ErrNotFound)
	exec(t, f.tx, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, f.project, f.personal)
	participants, err = r.ProjectParticipants(ctx, f.project)
	if err != nil || len(participants) != 1 || participants[0].InheritedFrom.Team.Kind != "personal" {
		t.Fatalf("personal participants = %+v, %v", participants, err)
	}
	exec(t, f.tx, `DELETE FROM users WHERE id=$1`, f.owner)
	_, err = r.ProjectParticipants(ctx, f.project)
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing profile = %v", err)
	}
}

func TestProjectPaginationScopesAndBudgets(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	r := project.NewReader(f.tx)
	second := uuid.NewString()
	_, _, err := project.NewCreation(f.tx, f.owner).InsertProject(ctx, second, strings.Repeat("x", 40), "host:second", f.personal)
	if err != nil {
		t.Fatal(err)
	}
	_, err = project.NewWriter(f.tx, second).CreateGrant(ctx, f.member, model.ProjectMemberRole)
	if err != nil {
		t.Fatal(err)
	}
	for _, scoped := range []bool{false, true} {
		var page store.ProjectPage
		if scoped {
			page, err = r.AccessibleProjects(ctx, principal(f.member), store.Page{Limit: 1})
		} else {
			page, err = r.Projects(ctx, store.Page{Limit: 1})
		}
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != f.project || !page.HasMore {
			t.Fatalf("first page = %+v, %v", page, err)
		}
		after := store.Page{Limit: 1, After: &store.Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].ID}}
		if scoped {
			page, err = r.AccessibleProjects(ctx, principal(f.member), after)
		} else {
			page, err = r.Projects(ctx, after)
		}
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != second || page.HasMore {
			t.Fatalf("last page = %+v, %v", page, err)
		}
	}
	for _, tc := range []struct {
		scope store.ProjectScope
		ids   []string
	}{{store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: f.team}, []string{f.project}}, {store.ProjectScope{Kind: store.ProjectScopeShared}, []string{second}}, {store.ProjectScope{Kind: store.ProjectScopeAll}, []string{f.project, second}}} {
		page, err := r.ScopedProjects(ctx, principal(f.member), tc.scope, store.Page{Limit: 10})
		if err != nil || len(page.Items) != len(tc.ids) {
			t.Fatalf("scope = %+v, %v", page, err)
		}
		for i, id := range tc.ids {
			if page.Items[i].ID != id {
				t.Fatalf("ids = %+v", page.Items)
			}
		}
	}
	page, err := r.ScopedProjects(ctx, principal(f.member), store.ProjectScope{Kind: store.ProjectScopeAll, MaxItemBytes: 20}, store.Page{Limit: 10})
	if err != nil || len(page.Items) != 1 || !page.HasMore {
		t.Fatalf("bounded page = %+v, %v", page, err)
	}
	oversized, err := r.ScopedProjects(ctx, principal(f.member), store.ProjectScope{Kind: store.ProjectScopeAll, MaxItemBytes: 1}, store.Page{Limit: 10})
	if err != nil || oversized.Oversized == nil || oversized.Oversized.ID != f.project || oversized.Oversized.CreatedAt.IsZero() || oversized.Oversized.Name != "" || oversized.Oversized.RepoURL != "" || len(oversized.Items) != 0 || !oversized.HasMore {
		t.Fatalf("oversized = %#v %v", oversized, err)
	}
	for _, scope := range []store.ProjectScope{{Kind: store.ProjectScopeAll, MaxItemBytes: -1}, {Kind: store.ProjectScopeAll, MaxItemBytes: 128<<20 + 1}, {Kind: store.ProjectScopeAll, TeamID: f.team}, {Kind: store.ProjectScopeShared, TeamID: f.team}, {Kind: store.ProjectScopeTeam}, {Kind: "unknown"}, {Kind: store.ProjectScopeTeam, TeamID: f.personal}} {
		_, err := r.ScopedProjects(ctx, principal(f.member), scope, store.Page{Limit: 10})
		if err == nil {
			t.Fatalf("invalid scope accepted: %+v", scope)
		}
	}
}

func TestInvitationLifecycleIsProjectScoped(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	w := project.NewWriter(f.tx, f.project)
	r := project.NewReader(f.tx)
	now := time.Now().UTC().Truncate(time.Microsecond)
	makeInvite := func(label string, at time.Time) model.ProjectInvitation {
		hash := sha256.Sum256([]byte(label))
		return model.ProjectInvitation{ID: uuid.NewString(), CreatedBy: f.owner, TokenHash: hash[:], CreatedAt: at, ExpiresAt: at.Add(time.Hour)}
	}
	expired := makeInvite("expired", now.Add(-2*time.Hour))
	if err := w.CreateInvitation(ctx, expired); err != nil {
		t.Fatal(err)
	}
	active := makeInvite("active", now)
	if err := w.CreateInvitation(ctx, active); err != nil {
		t.Fatal(err)
	}
	_, err := r.Invitation(ctx, expired.TokenHash)
	checkError(t, err, model.ErrNotFound)
	stored, err := w.LockInvitation(ctx, active.TokenHash)
	if err != nil || stored.ProjectID != f.project || stored.CreatedBy != f.owner || !bytes.Equal(stored.TokenHash, active.TokenHash) || !stored.ExpiresAt.Equal(active.ExpiresAt) {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	other := project.NewWriter(f.tx, uuid.NewString())
	_, err = other.LockInvitation(ctx, active.TokenHash)
	checkError(t, err, model.ErrNotFound)
	if err := other.RevokeInvitation(ctx, active.ID, now); err != nil {
		t.Fatal(err)
	}
	if err := other.ConsumeInvitation(ctx, active.ID, f.member, now); err != nil {
		t.Fatal(err)
	}
	list, err := r.Invitations(ctx, f.project, now)
	if err != nil || len(list) != 1 || list[0].TokenHash != nil || list[0].ConsumedAt != nil || list[0].RevokedAt != nil {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if err := w.ConsumeInvitation(ctx, active.ID, f.member, now); err != nil {
		t.Fatal(err)
	}
	if err := w.RevokeInvitation(ctx, active.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	consumed, err := r.Invitation(ctx, active.TokenHash)
	if err != nil || consumed.ConsumedBy == nil || *consumed.ConsumedBy != f.member || consumed.RevokedAt != nil || !consumed.ConsumedAt.Equal(now) {
		t.Fatalf("consumed = %+v, %v", consumed, err)
	}
	revoked := makeInvite("revoked", now)
	if err := w.CreateInvitation(ctx, revoked); err != nil {
		t.Fatal(err)
	}
	if err := w.RevokeInvitation(ctx, revoked.ID, now); err != nil {
		t.Fatal(err)
	}
	if err := w.RevokeInvitation(ctx, revoked.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	stored, err = r.Invitation(ctx, revoked.TokenHash)
	if err != nil || stored.RevokedAt == nil || !stored.RevokedAt.Equal(now) {
		t.Fatalf("revoked = %+v, %v", stored, err)
	}
	list, err = r.Invitations(ctx, f.project, now)
	if err != nil || len(list) != 0 {
		t.Fatalf("inactive invitations = %+v, %v", list, err)
	}
}

func TestTransferDAOOwnershipAndRoleSources(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	r := project.NewReader(f.tx)
	w := project.NewWriter(f.tx, f.project)
	ordinary, err := r.TransferTeam(ctx, f.team)
	if err != nil || ordinary.Ref.Kind != "ordinary" || ordinary.Ref.Name == nil || *ordinary.Ref.Name != "Team" {
		t.Fatalf("ordinary = %+v, %v", ordinary, err)
	}
	personal, err := r.TransferTeam(ctx, f.personal)
	if err != nil || personal.Ref.Kind != "personal" || personal.Ref.Name != nil {
		t.Fatalf("personal = %+v, %v", personal, err)
	}
	for _, tc := range []struct {
		user string
		want model.ProjectRole
	}{{f.owner, model.ProjectAdmin}, {f.member, model.ProjectMemberRole}, {f.guest, ""}} {
		role, err := r.TransferRole(ctx, tc.user, f.project, f.team)
		if err != nil || tc.want == "" && role != nil || tc.want != "" && (role == nil || *role != tc.want) {
			t.Fatalf("role = %v, %v", role, err)
		}
	}
	ownership, err := w.LockTransferOwnership(ctx)
	if err != nil || ownership.TeamID != f.team {
		t.Fatalf("ownership = %+v, %v", ownership, err)
	}
	source, target, err := w.LockTransferTeams(ctx, f.team, f.personal)
	if err != nil || source.Ref.ID != f.team || target.Ref.ID != f.personal {
		t.Fatalf("teams = %+v %+v, %v", source, target, err)
	}
	source, target, err = w.LockTransferTeams(ctx, f.team, f.team)
	if err != nil || !reflect.DeepEqual(source, target) {
		t.Fatalf("same team = %+v %+v, %v", source, target, err)
	}
	_, target, err = w.LockTransferTeams(ctx, f.team, uuid.NewString())
	if err != nil || target.Ref.ID != "" {
		t.Fatalf("missing destination = %+v, %v", target, err)
	}
	_, _, err = w.LockTransferTeams(ctx, uuid.NewString(), f.team)
	if err == nil || !strings.Contains(err.Error(), "owner Team is missing") {
		t.Fatalf("missing source = %v", err)
	}
	moved, err := w.MoveOwnership(ctx, f.personal)
	if err != nil || moved.TeamID != f.personal || moved.Version != ownership.Version+1 || moved.UpdatedAt.Before(ownership.UpdatedAt) {
		t.Fatalf("moved = %+v, %v", moved, err)
	}
	saved, err := w.Project(ctx)
	if err != nil || saved.Ownership.TeamID != moved.TeamID || saved.Ownership.Version != moved.Version || !saved.Ownership.UpdatedAt.Equal(moved.UpdatedAt) || saved.UpdatedAt.Before(moved.UpdatedAt) {
		t.Fatalf("readback = %+v; moved = %+v; error = %v", saved, moved, err)
	}
	_, err = project.NewWriter(f.tx, uuid.NewString()).LockTransferOwnership(ctx)
	if err == nil || !strings.Contains(err.Error(), "ownership is missing") {
		t.Fatalf("missing ownership = %v", err)
	}
}
