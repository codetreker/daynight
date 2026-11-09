package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func membershipFixture(t *testing.T) (*Store, model.Principal, model.Principal, model.Project) {
	t.Helper()
	s := isolatedStore(t)
	_, admin, _ := testAuthRecords(t, s)
	_, member, _ := testAuthRecords(t, s)
	project, err := s.CreatePrivateProject(context.Background(), admin, uuid.NewString(), "Private project", "https://example.com/private")
	if err != nil {
		t.Fatal(err)
	}
	return s, admin, member, project
}

func newStoredInvitation(project model.Project, creator model.Principal, label string) model.ProjectInvitation {
	hash := sha256.Sum256([]byte(label))
	now := time.Now().UTC()
	return model.ProjectInvitation{ID: uuid.NewString(), ProjectID: project.ID, CreatedBy: creator.UserID, TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
}

func TestMembershipStorageLifecycleAndPagination(t *testing.T) {
	s, admin, member, project := membershipFixture(t)
	ctx := context.Background()
	inaccessible, err := s.CreatePrivateProject(ctx, member, uuid.NewString(), "Other", "https://example.com/other")
	if err != nil {
		t.Fatal(err)
	}
	later, err := s.CreatePrivateProject(ctx, admin, uuid.NewString(), "Later", "https://example.com/later")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE projects SET created_at=$2::timestamptz WHERE id=$1`, inaccessible.ID, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	var original model.ProjectMember
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		original, err = snapshot.ProjectDAO().DirectProjectMember(ctx, admin.UserID, project.ID)
		if err != nil {
			return err
		}
		if original.Grant.Role != model.ProjectAdmin || original.Grant.UserID != admin.UserID || original.Grant.Version < 1 {
			t.Fatalf("first admin: %+v", original)
		}
		access, err := snapshot.ProjectDAO().ProjectAccess(ctx, admin, project.ID)
		if err != nil || (access.ProjectID != project.ID || access.UserID != admin.UserID || access.Role != model.ProjectAdmin || !reflect.DeepEqual(access.DirectGrant, &original.Grant)) {
			t.Fatalf("admin access: %+v %v", access, err)
		}
		page, err := snapshot.ProjectDAO().AccessibleProjects(ctx, admin, Page{Limit: 1})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.Items[0].ID != project.ID || !page.HasMore {
			t.Fatalf("first filtered page: %+v", page)
		}
		next, err := snapshot.ProjectDAO().AccessibleProjects(ctx, admin, Page{Limit: 1, After: &Position{ID: page.Items[0].ID, CreatedAt: page.Items[0].CreatedAt}})
		if err != nil {
			return err
		}
		if len(next.Items) != 1 || next.Items[0].ID != later.ID || next.HasMore {
			t.Fatalf("second filtered page: %+v", next)
		}
		_, err = snapshot.ProjectDAO().ProjectAccess(ctx, member, project.ID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("nonmember found: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	invitation := newStoredInvitation(project, admin, "lifecycle")
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		current, err := tx.ProjectDAO().DirectProjectMember(ctx, admin.UserID)
		if err != nil {
			return err
		}
		if current.Grant.Version != original.Grant.Version {
			t.Fatal("snapshot mismatch")
		}
		access, err := tx.ProjectDAO().ProjectAccess(ctx, admin)
		if err != nil || (access.ProjectID != project.ID || access.UserID != admin.UserID || access.Role != model.ProjectAdmin || !reflect.DeepEqual(access.DirectGrant, &current.Grant)) {
			t.Fatalf("write admission: %+v %v", access, err)
		}
		return tx.ProjectDAO().CreateInvitation(ctx, invitation)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		found, err := snapshot.ProjectDAO().Invitation(ctx, invitation.TokenHash)
		if err != nil {
			return err
		}
		if found.CreatedBy != admin.UserID || found.ExpiresAt.Sub(found.CreatedAt) != 7*24*time.Hour {
			t.Fatal("invitation persistence")
		}
		invitations, err := snapshot.ProjectDAO().Invitations(ctx, project.ID, time.Now())
		if err != nil {
			return err
		}
		if len(invitations) != 1 || invitations[0].TokenHash != nil {
			t.Fatal("metadata leaked secret")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var invited model.ProjectMember
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		invite, err := tx.ProjectDAO().LockInvitation(ctx, invitation.TokenHash)
		if err != nil {
			return err
		}
		invited, err = tx.ProjectDAO().AddInvitedMember(ctx, member.UserID)
		if err != nil {
			return err
		}
		if invited.Grant.Role != model.ProjectMemberRole || invited.Grant.Version <= original.Grant.Version {
			t.Fatal("invited role/version")
		}
		return tx.ProjectDAO().ConsumeInvitation(ctx, invite.ID, member.UserID, time.Now())
	}); err != nil {
		t.Fatal(err)
	}
	var consumedBy string
	var acceptedGrants int
	if err := s.Pool.QueryRow(ctx, `SELECT consumed_by::text,
		(SELECT count(*) FROM project_grants WHERE project_id=$2 AND user_id=$3)
		FROM project_invitations WHERE id=$1`, invitation.ID, project.ID, member.UserID).Scan(&consumedBy, &acceptedGrants); err != nil || consumedBy != member.UserID || acceptedGrants != 1 {
		t.Fatalf("committed invitation actor and unique grant: %q %d %v", consumedBy, acceptedGrants, err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		access, err := snapshot.ProjectDAO().ProjectAccess(ctx, member, project.ID)
		if err != nil || (access.ProjectID != project.ID || access.UserID != member.UserID || access.Role != model.ProjectMemberRole || !reflect.DeepEqual(access.DirectGrant, &invited.Grant)) {
			t.Fatalf("invited access: %+v %v", access, err)
		}
		members, err := snapshot.ProjectDAO().ProjectParticipants(ctx, project.ID)
		if err != nil {
			return err
		}
		if len(members) != 2 {
			t.Fatal("membership list")
		}
		invitations, err := snapshot.ProjectDAO().Invitations(ctx, project.ID, time.Now())
		if err != nil {
			return err
		}
		if len(invitations) != 0 {
			t.Fatal("consumed invite listed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		changed, err := tx.ProjectDAO().SetMemberRole(ctx, member.UserID, model.ProjectAdmin)
		if err != nil {
			return err
		}
		if changed.Grant.Version <= invited.Grant.Version {
			t.Fatal("version did not advance")
		}
		if err := tx.ProjectDAO().RemoveMember(ctx, member.UserID); err != nil {
			return err
		}
		rejoined, err := tx.ProjectDAO().AddInvitedMember(ctx, member.UserID)
		if err != nil {
			return err
		}
		if rejoined.Grant.Version <= changed.Grant.Version {
			t.Fatal("rejoin reused old observation version")
		}
		second := newStoredInvitation(project, admin, "revoked")
		if err := tx.ProjectDAO().CreateInvitation(ctx, second); err != nil {
			return err
		}
		for range 2 {
			if err := tx.ProjectDAO().RevokeInvitation(ctx, second.ID, time.Now()); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMembershipStorageConstraintsRollbackAndBoundedCleanup(t *testing.T) {
	s, admin, _, project := membershipFixture(t)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO project_grants (project_id,user_id,role) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','owner')`,
		`INSERT INTO project_grants (project_id,user_id,role,version) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member',0)`,
		`INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',decode('00','hex'),now(),now()+interval '1 day')`,
		`INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at,consumed_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',decode(repeat('00',32),'hex'),now(),now()+interval '1 day',now())`,
	} {
		_, err := s.Pool.Exec(ctx, sql)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatalf("invalid record accepted: %v", err)
		}
	}
	if _, err := s.Pool.Exec(ctx, `CREATE FUNCTION reject_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test member rollback'; END $$; CREATE TRIGGER reject_member BEFORE INSERT ON project_grants FOR EACH ROW EXECUTE FUNCTION reject_member()`); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	if _, err := s.CreatePrivateProject(ctx, admin, id, "Rollback", "https://example.com/rollback"); err == nil {
		t.Fatal("membership failure accepted")
	}
	var exists bool
	if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)`, id).Scan(&exists); err != nil || exists {
		t.Fatalf("half project remained: %t %v", exists, err)
	}
	if _, err := s.Pool.Exec(ctx, `DROP TRIGGER reject_member ON project_grants; DROP FUNCTION reject_member()`); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := s.Pool.Exec(ctx, `INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at) SELECT md5(n::text)::uuid,$1,$2,sha256(n::text::bytea),$3::timestamptz-interval '2 hours',$3::timestamptz-interval '1 hour' FROM generate_series(1,120) n`, project.ID, admin.UserID, now); err != nil {
		t.Fatal(err)
	}
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		return tx.ProjectDAO().CreateInvitation(ctx, newStoredInvitation(project, admin, "fresh"))
	}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_invitations WHERE expires_at<=$1`, now).Scan(&count); err != nil || count != 20 {
		t.Fatalf("cleanup: %d %v", count, err)
	}
}

func TestMembershipStorageOperationalFailures(t *testing.T) {
	s, admin, member, project := membershipFixture(t)
	for _, phase := range []string{"private-project", "project-member", "project-access", "write-access", "accessible", "members", "target-member", "set-role", "remove", "add", "inspect", "lock", "create", "list-invites", "revoke", "consume"} {
		if !t.Run(phase, func(t *testing.T) {
			ctx := context.Background()
			invite := newStoredInvitation(project, admin, "fault")
			table := "project_grants"
			if phase == "private-project" {
				table = "projects"
			}
			if phase == "inspect" || phase == "lock" || phase == "create" || phase == "list-invites" || phase == "revoke" || phase == "consume" {
				table = "project_invitations"
			}
			var tableOID uint32
			if err := s.Pool.QueryRow(ctx, "SELECT $1::regclass::oid", table).Scan(&tableOID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Pool.Exec(ctx, "ALTER TABLE "+pgx.Identifier{table}.Sanitize()+" RENAME TO membership_failure_source"); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if _, err := s.Pool.Exec(ctx, "ALTER TABLE membership_failure_source RENAME TO "+pgx.Identifier{table}.Sanitize()); err != nil {
					t.Errorf("restore membership table: %v", err)
					return
				}
				var restored bool
				if err := s.Pool.QueryRow(ctx, "SELECT to_regclass($1)::oid=$2 AND to_regclass('membership_failure_source') IS NULL", table, tableOID).Scan(&restored); err != nil || !restored {
					t.Errorf("membership table was not restored: %t %v", restored, err)
				}
			})
			var err error
			switch phase {
			case "private-project":
				_, err = s.CreatePrivateProject(ctx, admin, uuid.NewString(), "Missing", "https://example.com/missing")
			case "project-member", "project-access", "accessible", "members", "inspect", "list-invites":
				err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
					var err error
					switch phase {
					case "project-member":
						_, err = snapshot.ProjectDAO().DirectProjectMember(ctx, admin.UserID, project.ID)
					case "project-access":
						_, err = snapshot.ProjectDAO().ProjectAccess(ctx, admin, project.ID)
					case "accessible":
						_, err = snapshot.ProjectDAO().AccessibleProjects(ctx, admin, Page{Limit: 1})
					case "members":
						_, err = snapshot.ProjectDAO().ProjectParticipants(ctx, project.ID)
					case "inspect":
						_, err = snapshot.ProjectDAO().Invitation(ctx, invite.TokenHash)
					case "list-invites":
						_, err = snapshot.ProjectDAO().Invitations(ctx, project.ID, time.Now())
					}
					return err
				})
			default:
				err = writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
					var err error
					switch phase {
					case "write-access":
						_, err = tx.ProjectDAO().ProjectAccess(ctx, admin)
					case "target-member":
						_, err = tx.ProjectDAO().DirectProjectMember(ctx, member.UserID)
					case "set-role":
						_, err = tx.ProjectDAO().SetMemberRole(ctx, admin.UserID, model.ProjectMemberRole)
					case "remove":
						err = tx.ProjectDAO().RemoveMember(ctx, member.UserID)
					case "add":
						_, err = tx.ProjectDAO().AddInvitedMember(ctx, member.UserID)
					case "lock":
						_, err = tx.ProjectDAO().LockInvitation(ctx, invite.TokenHash)
					case "create":
						err = tx.ProjectDAO().CreateInvitation(ctx, invite)
					case "revoke":
						err = tx.ProjectDAO().RevokeInvitation(ctx, invite.ID, time.Now())
					case "consume":
						err = tx.ProjectDAO().ConsumeInvitation(ctx, invite.ID, member.UserID, time.Now())
					}
					return err
				})
			}
			var databaseError *Error
			var queryError *pgconn.PgError
			if !errors.As(err, &databaseError) || !errors.As(err, &queryError) || queryError.Code != "42P01" || strings.Contains(err.Error(), "SELECT") {
				t.Fatalf("missing chain or leaked SQL: %v", err)
			}
		}) {
			return
		}
	}
	s.Close()
	if _, err := s.CreatePrivateProject(context.Background(), admin, uuid.NewString(), "Closed", "https://example.com/closed"); err == nil {
		t.Fatal("closed pool accepted")
	}
}

func TestProjectParticipantsKeepGrantFactsAndRequireCanonicalProfiles(t *testing.T) {
	s, admin, member, project := membershipFixture(t)
	ctx := context.Background()
	var direct model.ProjectMember
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		var err error
		direct, err = tx.ProjectDAO().AddInvitedMember(ctx, member.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	name, email, avatar := "  Participant  ", "participant@example.test", "https://example.test/avatar"
	if _, err := s.Pool.Exec(ctx, `UPDATE users SET name=$2,email=$3,avatar_url=$4 WHERE id=$1`, admin.UserID, name, email, avatar); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		people, err := snapshot.ProjectDAO().ProjectParticipants(ctx, project.ID)
		if err != nil {
			return err
		}
		if len(people) != 2 || people[0].UserID != admin.UserID || people[1].UserID != member.UserID {
			t.Fatalf("deduplicated ordered participants: %#v", people)
		}
		if !reflect.DeepEqual(people[0].Profile, model.ProjectParticipantProfile{Name: &name, Email: &email, AvatarURL: &avatar}) || people[0].EffectiveRole != model.ProjectAdmin {
			t.Fatalf("canonical profile: %#v", people[0])
		}
		if !reflect.DeepEqual(people[1], model.ProjectParticipant{UserID: member.UserID, Profile: model.ProjectParticipantProfile{}, EffectiveRole: model.ProjectMemberRole, DirectGrant: &direct.Grant}) {
			t.Fatalf("nullable profile and exact grant: %#v", people[1])
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, member.UserID); err != nil {
		t.Fatal(err)
	}
	var integrity *Error
	err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		people, err := snapshot.ProjectDAO().ProjectParticipants(ctx, project.ID)
		if people != nil {
			t.Fatalf("integrity failure returned a partial roster: %#v", people)
		}
		if !errors.As(err, &integrity) {
			t.Fatalf("integrity failure lost its store error: %v", err)
		}
		return err
	})
	if integrity == nil || !errors.Is(err, integrity) || !strings.Contains(integrity.Cause.Error(), "profile is missing or inconsistent") {
		t.Fatalf("missing canonical user did not fail: %v", err)
	}
}
