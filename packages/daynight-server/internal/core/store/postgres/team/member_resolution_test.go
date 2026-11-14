package team_test

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/google/uuid"
)

func TestMemberByExternalIDIsTeamScopedAndReadOnly(t *testing.T) {
	tx := teamTransaction(t)
	ctx := t.Context()
	owner := addUser(t, tx, "Owner")
	member := addUser(t, tx, "Member")
	outsider := addUser(t, tx, "Outsider")
	current := createTeam(t, tx, owner, "Current")
	other := createTeam(t, tx, outsider, "Other")
	execute(t, tx, `UPDATE users SET uniauth_id=$2 WHERE id=$1`, member, "opaque:external-key")
	execute(t, tx, `INSERT INTO team_members(team_id,user_id,role,version) VALUES($1,$2,'member',$3)`, current.ID, member, int64(math.MaxInt64))
	execute(t, tx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, other.ID, member)
	writer := team.NewWriter(tx, current.ID)
	var before string
	if err := tx.QueryRow(ctx, `SELECT json_build_array(
 (SELECT json_agg(row_to_json(u) ORDER BY u.id) FROM users u),
 (SELECT json_agg(row_to_json(m) ORDER BY m.team_id,m.user_id) FROM team_members m),
 (SELECT count(*) FROM sessions), (SELECT count(*) FROM personal_access_tokens),
 (SELECT count(*) FROM oauth_access_tokens))::text`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, target := range []struct{ external, id string }{{owner, owner}, {"opaque:external-key", member}} {
		want, err := writer.Member(ctx, target.id)
		if err != nil {
			t.Fatal(err)
		}
		got, err := writer.MemberByExternalID(ctx, target.external)
		if err != nil || got != want {
			t.Fatalf("existing membership: got %#v, want %#v, error %v", got, want, err)
		}
	}
	for _, external := range []string{outsider, "not-present:" + uuid.NewString(), "opaque:EXTERNAL-key"} {
		got, err := writer.MemberByExternalID(ctx, external)
		if got != (model.TeamMember{}) || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("absent mapping: %#v %v", got, err)
		}
	}
	var after string
	if err := tx.QueryRow(ctx, `SELECT json_build_array(
 (SELECT json_agg(row_to_json(u) ORDER BY u.id) FROM users u),
 (SELECT json_agg(row_to_json(m) ORDER BY m.team_id,m.user_id) FROM team_members m),
 (SELECT count(*) FROM sessions), (SELECT count(*) FROM personal_access_tokens),
 (SELECT count(*) FROM oauth_access_tokens))::text`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatal("resolving changed users, memberships or credential counts")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := writer.MemberByExternalID(canceled, owner); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled resolve: %v", err)
	}
}
