package team_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/google/uuid"
)

func TestMemberCandidateReadsActualProfileWithoutCreatingAccounts(t *testing.T) {
	tx := teamTransaction(t)
	owner := addUser(t, tx, "Owner")
	target := addUser(t, tx, "Current")
	teamID := createTeam(t, tx, owner, "Team").ID
	execute(t, tx, `UPDATE users SET email=$2,avatar_url=NULL WHERE id=$1`, target, "current@example.test")
	dao := team.NewWriter(tx, teamID)
	got, err := dao.MemberCandidate(t.Context(), target)
	if err != nil || got.UserID != target || got.Profile.Name == nil || *got.Profile.Name != "Current" || got.Profile.Email == nil || *got.Profile.Email != "current@example.test" || got.Profile.AvatarURL != nil {
		t.Fatalf("profile %+v: %v", got, err)
	}
	missing := uuid.NewString()
	if _, err = dao.MemberCandidate(t.Context(), missing); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	var count int
	if err = tx.QueryRow(t.Context(), `SELECT count(*) FROM users WHERE id=$1`, missing).Scan(&count); err != nil || count != 0 {
		t.Fatalf("missing user count %d: %v", count, err)
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err = dao.MemberCandidate(canceled, target); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
