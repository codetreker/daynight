package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	teamstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamMemberStoreSnapshotAndMutation(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	_, other, _ := testAuthRecords(t, s)
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, other.UserID)
	project, _, err := s.CreateProjectInTeam(ctx, actor, uuid.NewString(), "Team-owned project", "host:repo", &team.ID)
	if err != nil {
		t.Fatal(err)
	}
	var directGrant model.ProjectGrant
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		member, err := tx.ProjectDAO().AddInvitedMember(ctx, other.UserID)
		directGrant = member.Grant
		return err
	}); err != nil {
		t.Fatal(err)
	}
	const directVersion int64 = 9007199254740993
	mustQueryExec(t, s, `UPDATE project_grants SET version=$3 WHERE project_id=$1 AND user_id=$2`, project.ID, other.UserID, directVersion)
	directGrant.Version = directVersion
	err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		original, err := snapshot.TeamDAO().TeamMembers(ctx, team.ID)
		if err != nil {
			return err
		}
		if len(original) != 2 || original[0].Membership.UserID != actor.UserID || original[1].Membership.UserID != other.UserID {
			t.Fatalf("directory: %#v", original)
		}
		if original[1].Profile.Name != nil || original[1].Profile.Email != nil || original[1].Profile.AvatarURL != nil {
			t.Fatalf("nullable profile: %#v", original[1].Profile)
		}
		err = testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
			member, err := tx.Member(ctx, other.UserID)
			if err != nil || member != original[1].Membership {
				t.Fatalf("member: %#v %v", member, err)
			}
			count, err := tx.AdminCount(ctx)
			if err != nil || count != 1 {
				t.Fatalf("admin count %d %v", count, err)
			}
			updated, err := tx.SetMemberRole(ctx, other.UserID, model.ProjectAdmin)
			if err != nil || updated.Role != model.ProjectAdmin || updated.Version <= member.Version {
				t.Fatalf("updated relation %#v %v", updated, err)
			}
			return nil
		})
		if err != nil {
			return err
		}
		again, err := snapshot.TeamDAO().TeamMembers(ctx, team.ID)
		if err == nil && !reflect.DeepEqual(original, again) {
			t.Fatalf("snapshot changed: %#v %#v", original, again)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
		count, err := tx.AdminCount(ctx)
		if err != nil || count != 2 {
			t.Fatalf("committed admin count %d %v", count, err)
		}
		return tx.RemoveMember(ctx, other.UserID)
	})
	if err != nil {
		t.Fatal(err)
	}
	err = testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error { _, err := tx.Member(ctx, other.UserID); return err })
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("removed membership: %v", err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.TeamDAO().Team(ctx, other.UserID, team.ID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("self-exit retained Team access: %v", err)
		}
		access, err := snapshot.ProjectDAO().ProjectAccess(ctx, other, project.ID)
		if err != nil || access.Role != model.ProjectMemberRole || access.TeamRole != nil || !reflect.DeepEqual(access.DirectGrant, &directGrant) {
			t.Fatalf("Team self-exit changed the independent Project grant: %#v %v", access, err)
		}
		read, err := snapshot.ProjectDAO().Project(ctx, project.ID)
		if err == nil && !reflect.DeepEqual(read, project) {
			t.Fatalf("Team membership removal changed Project metadata: %#v %#v", read, project)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTeamMemberMutationFailuresRollbackAndPreserveCauses(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, operation := range []string{"update", "delete"} {
		t.Run(operation, func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			ctx := context.Background()
			event := "UPDATE"
			if operation == "delete" {
				event = "DELETE"
			}
			mustQueryExec(t, s, `CREATE FUNCTION refuse_member_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'member failure'; END $$;
 CREATE TRIGGER refuse_member_change BEFORE `+event+` ON team_members FOR EACH ROW EXECUTE FUNCTION refuse_member_change()`)
			err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
				if operation == "update" {
					_, err := tx.SetMemberRole(ctx, actor.UserID, model.ProjectMemberRole)
					return err
				}
				return tx.RemoveMember(ctx, actor.UserID)
			})
			var transaction *TransactionError
			var database *pgconn.PgError
			if !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted || transaction.CommitAttempted || !errors.As(err, &database) || database.Code != "P0001" {
				t.Fatalf("rollback failure %#v %v", transaction, err)
			}
			if got := readStoreTeam(t, s, actor.UserID, team.ID); !reflect.DeepEqual(got, team) {
				t.Fatalf("failed mutation changed relationship: %#v", got)
			}
		})
	}
}

func TestTeamMemberCancellationAndUnknownCommit(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
		if _, err := tx.SetMemberRole(ctx, actor.UserID, model.ProjectMemberRole); err != nil {
			return err
		}
		cancel()
		return nil
	})
	var failure *TransactionError
	if !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Outcome != TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("canceled write %#v %v", failure, err)
	}
	if got := readStoreTeam(t, s, actor.UserID, team.ID); !reflect.DeepEqual(got, team) {
		t.Fatalf("canceled write persisted: %#v", got)
	}
	base := context.Background()
	tx, err := s.Pool.BeginTx(base, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("commit response lost")
	err = transact(base, &threadCommitResponseLoss{Tx: tx, cause: lost}, func(raw pgx.Tx) error {
		var id string
		if err := raw.QueryRow(base, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, team.ID).Scan(&id); err != nil {
			return err
		}
		_, err := teamstore.NewWriter(raw, team.ID).SetMemberRole(base, actor.UserID, model.ProjectMemberRole)
		return err
	})
	if !errors.Is(err, lost) || !errors.As(err, &failure) || failure.Outcome != TransactionUnknown || !failure.CommitAttempted {
		t.Fatalf("unknown write %#v %v", failure, err)
	}
	got := readStoreTeam(t, s, actor.UserID, team.ID)
	if got.Membership.Role != model.ProjectMemberRole || got.Membership.Version <= team.Membership.Version {
		t.Fatalf("actual committed membership: %#v", got.Membership)
	}
}
