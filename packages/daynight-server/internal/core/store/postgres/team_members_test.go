package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	teamstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamMemberStoreSnapshotAndMutation(t *testing.T) {
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
	var promoted model.TeamMember
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
			promoted = updated
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
	var rejoined model.TeamMember
	if err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
		var err error
		rejoined, err = tx.AddInvitedMember(ctx, other.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	rejoined.CreatedAt, rejoined.UpdatedAt = rejoined.CreatedAt.UTC(), rejoined.UpdatedAt.UTC()
	if rejoined.UserID != other.UserID || rejoined.TeamID != team.ID || rejoined.Role != model.ProjectMemberRole || rejoined.Version <= promoted.Version {
		t.Fatalf("rejoined membership reused its removed version: removed %#v rejoined %#v", promoted, rejoined)
	}
	if fresh := readStoreTeam(t, s, other.UserID, team.ID).Membership; !reflect.DeepEqual(fresh, rejoined) {
		t.Fatalf("fresh rejoined membership differs: written %#v fresh %#v", rejoined, fresh)
	}
	for _, remove := range []bool{false, true} {
		t.Run(map[bool]string{false: "serialized demotion", true: "serialized removal"}[remove], func(t *testing.T) {
			s, first, team := storeTeamFixture(t)
			_, second, _ := testAuthRecords(t, s)
			mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team.ID, second.UserID)
			secondBefore := readStoreTeam(t, s, second.UserID, team.ID).Membership
			var changed model.TeamMember
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			completion, err := s.WriteTeam(ctx, team.ID, func(scope TeamWriteScope) error {
				dao := scope.TeamDAO()
				count, err := dao.AdminCount(ctx)
				if err != nil || count != 2 {
					return fmt.Errorf("initial administrator count %d: %w", count, err)
				}
				if remove {
					err = dao.RemoveMember(ctx, first.UserID)
				} else {
					changed, err = dao.SetMemberRole(ctx, first.UserID, model.ProjectMemberRole)
				}
				if err != nil {
					return err
				}
				go func() {
					_, err := s.WriteTeam(ctx, team.ID, func(waiter TeamWriteScope) error {
						count, err := waiter.TeamDAO().AdminCount(ctx)
						if err != nil || count != 1 {
							return fmt.Errorf("serialized administrator count %d: %w", count, err)
						}
						member, err := waiter.TeamDAO().Member(ctx, first.UserID)
						if remove {
							if !errors.Is(err, model.ErrNotFound) {
								return fmt.Errorf("removed administrator still present: %#v %v", member, err)
							}
						} else if err != nil || member.Role != model.ProjectMemberRole || member.Version <= team.Membership.Version {
							return fmt.Errorf("demoted administrator is stale: %#v %v", member, err)
						}
						remaining, err := waiter.TeamDAO().Member(ctx, second.UserID)
						if err != nil || remaining.Role != model.ProjectAdmin {
							return fmt.Errorf("remaining administrator changed: %#v %v", remaining, err)
						}
						return nil
					})
					done <- err
				}()
				testutil.WaitTransferTeamLock(t, ctx, s.Pool, "SELECT id::text FROM teams WHERE", scope.(teamWriteScope).tx.Conn().PgConn().PID())
				return nil
			})
			if err != nil || completion.Outcome != TransactionCommitted {
				t.Fatalf("first mutation completion %#v %v", completion, err)
			}
			if err := receiveQueryResult(t, ctx, done); err != nil {
				t.Fatal(err)
			}
			var admins, members int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE role='admin'),count(*) FROM team_members WHERE team_id=$1`, team.ID).Scan(&admins, &members); err != nil || admins != 1 || members != map[bool]int{false: 2, true: 1}[remove] {
				t.Fatalf("fresh committed directory: admins=%d members=%d %v", admins, members, err)
			}
			if after := readStoreTeam(t, s, second.UserID, team.ID).Membership; !reflect.DeepEqual(after, secondBefore) {
				t.Fatalf("remaining administrator changed: before %#v after %#v", secondBefore, after)
			}
			if !remove {
				if after := readStoreTeam(t, s, first.UserID, team.ID).Membership; !reflect.DeepEqual(after, changed) {
					t.Fatalf("fresh demotion differs from written row: %#v %#v", changed, after)
				}
			}
		})
	}
}

func TestTeamMemberMutationFailuresRollbackAndPreserveCauses(t *testing.T) {
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
	t.Run("orphaned subscribed Project", func(t *testing.T) {
		s, _, team := storeTeamFixture(t)
		_, member, _ := testAuthRecords(t, s)
		ctx := t.Context()
		mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, member.UserID)
		before := readStoreTeam(t, s, member.UserID, team.ID).Membership
		project, subscription := uuid.NewString(), uuid.NewString()
		mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Orphaned subscribed Project','https://example.test/project')`, project)
		mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team.ID)
		mustQueryExec(t, s, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, subscription, uuid.NewString(), project, member.UserID)
		mustQueryExec(t, s, `DELETE FROM project_ownership WHERE project_id=$1`, project)
		var integrity error
		completion, err := s.WriteTeam(ctx, team.ID, func(scope TeamWriteScope) error {
			if err := scope.TeamDAO().RemoveMember(ctx, member.UserID); err != nil {
				return err
			}
			rows, err := scope.EligibilityDAO().LockAffected(ctx, WebhookEligibilityFilter{TeamID: team.ID, UserID: member.UserID})
			if err != nil || len(rows) != 1 || rows[0].ID != subscription || rows[0].State != "active" || rows[0].Epoch != 1 {
				return fmt.Errorf("orphan subscription not locked: %#v %v", rows, err)
			}
			_, integrity = scope.EligibilityDAO().ReadEligibility(ctx, rows[0].Owner, rows[0].ProjectID, member.UserID)
			return integrity
		})
		if integrity == nil || !strings.Contains(integrity.Error(), "ownership") || !errors.Is(err, integrity) || completion.Outcome != TransactionNotCommitted {
			t.Fatalf("cross-DAO integrity rollback: %#v %v (cause %v)", completion, err, integrity)
		}
		if after := readStoreTeam(t, s, member.UserID, team.ID).Membership; !reflect.DeepEqual(after, before) {
			t.Fatalf("cross-DAO failure persisted membership removal: before %#v after %#v", before, after)
		}
		var state string
		var epoch int64
		if err := s.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, subscription).Scan(&state, &epoch); err != nil || state != "active" || epoch != 1 {
			t.Fatalf("cross-DAO failure changed subscription: %s %d %v", state, epoch, err)
		}
	})
}

func TestTeamMemberCancellationAndUnknownCommit(t *testing.T) {
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
