package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func membershipFixture(t *testing.T) (*Store, core.Principal, core.Principal, core.Project) {
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

func newStoredInvitation(project core.Project, creator core.Principal, label string) core.ProjectInvitation {
	hash := sha256.Sum256([]byte(label))
	now := time.Now().UTC()
	return core.ProjectInvitation{ID: uuid.NewString(), ProjectID: project.ID, CreatedBy: creator.UserID, TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
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
	var original core.ProjectMember
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		var err error
		original, err = snapshot.DirectProjectMember(ctx, admin.UserID, project.ID)
		if err != nil {
			return err
		}
		if original.Grant.Role != core.ProjectAdmin || original.Grant.UserID != admin.UserID || original.Grant.Version < 1 {
			t.Fatalf("first admin: %+v", original)
		}
		access, err := snapshot.ProjectAccess(ctx, admin, project.ID)
		if err != nil || !reflect.DeepEqual(access, core.ProjectAccess{ProjectID: project.ID, UserID: admin.UserID, Role: core.ProjectAdmin, DirectGrant: &original.Grant}) {
			t.Fatalf("admin access: %+v %v", access, err)
		}
		page, err := snapshot.AccessibleProjects(ctx, admin, Page{Limit: 1})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.Items[0].ID != project.ID || !page.HasMore {
			t.Fatalf("first filtered page: %+v", page)
		}
		next, err := snapshot.AccessibleProjects(ctx, admin, Page{Limit: 1, After: &Position{ID: page.Items[0].ID, CreatedAt: page.Items[0].CreatedAt}})
		if err != nil {
			return err
		}
		if len(next.Items) != 1 || next.Items[0].ID != later.ID || next.HasMore {
			t.Fatalf("second filtered page: %+v", next)
		}
		_, err = snapshot.ProjectAccess(ctx, member, project.ID)
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("nonmember found: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	invitation := newStoredInvitation(project, admin, "lifecycle")
	if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		current, err := tx.DirectProjectMember(ctx, admin.UserID)
		if err != nil {
			return err
		}
		if current.Grant.Version != original.Grant.Version {
			t.Fatal("snapshot mismatch")
		}
		access, err := tx.ProjectAccess(ctx, admin)
		if err != nil || !reflect.DeepEqual(access, core.ProjectAccess{ProjectID: project.ID, UserID: admin.UserID, Role: core.ProjectAdmin, DirectGrant: &current.Grant}) {
			t.Fatalf("write admission: %+v %v", access, err)
		}
		count, err := tx.AdminCount(ctx)
		if err != nil {
			return err
		}
		if count != 1 {
			t.Fatal("initial admin count")
		}
		return tx.CreateInvitation(ctx, invitation)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		found, err := snapshot.Invitation(ctx, invitation.TokenHash)
		if err != nil {
			return err
		}
		if found.CreatedBy != admin.UserID || found.ExpiresAt.Sub(found.CreatedAt) != 7*24*time.Hour {
			t.Fatal("invitation persistence")
		}
		invitations, err := snapshot.Invitations(ctx, project.ID, time.Now())
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
	var invited core.ProjectMember
	if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		invite, err := tx.LockInvitation(ctx, invitation.TokenHash)
		if err != nil {
			return err
		}
		invited, err = tx.AddInvitedMember(ctx, member.UserID)
		if err != nil {
			return err
		}
		if invited.Grant.Role != core.ProjectMemberRole || invited.Grant.Version <= original.Grant.Version {
			t.Fatal("invited role/version")
		}
		return tx.ConsumeInvitation(ctx, invite.ID, member.UserID, time.Now())
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		access, err := snapshot.ProjectAccess(ctx, member, project.ID)
		if err != nil || !reflect.DeepEqual(access, core.ProjectAccess{ProjectID: project.ID, UserID: member.UserID, Role: core.ProjectMemberRole, DirectGrant: &invited.Grant}) {
			t.Fatalf("invited access: %+v %v", access, err)
		}
		members, err := snapshot.ProjectParticipants(ctx, project.ID)
		if err != nil {
			return err
		}
		if len(members) != 2 {
			t.Fatal("membership list")
		}
		invitations, err := snapshot.Invitations(ctx, project.ID, time.Now())
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
	if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		changed, err := tx.SetMemberRole(ctx, member.UserID, core.ProjectAdmin)
		if err != nil {
			return err
		}
		if changed.Grant.Version <= invited.Grant.Version {
			t.Fatal("version did not advance")
		}
		if err := tx.RemoveMember(ctx, member.UserID); err != nil {
			return err
		}
		rejoined, err := tx.AddInvitedMember(ctx, member.UserID)
		if err != nil {
			return err
		}
		if rejoined.Grant.Version <= changed.Grant.Version {
			t.Fatal("rejoin reused old observation version")
		}
		second := newStoredInvitation(project, admin, "revoked")
		if err := tx.CreateInvitation(ctx, second); err != nil {
			return err
		}
		for range 2 {
			if err := tx.RevokeInvitation(ctx, second.ID, time.Now()); err != nil {
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
		`INSERT INTO project_members (project_id,user_id,role) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','owner')`,
		`INSERT INTO project_members (project_id,user_id,role,version) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member',0)`,
		`INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',decode('00','hex'),now(),now()+interval '1 day')`,
		`INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at,consumed_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',decode(repeat('00',32),'hex'),now(),now()+interval '1 day',now())`,
	} {
		_, err := s.Pool.Exec(ctx, sql)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatalf("invalid record accepted: %v", err)
		}
	}
	if _, err := s.Pool.Exec(ctx, `CREATE FUNCTION reject_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test member rollback'; END $$; CREATE TRIGGER reject_member BEFORE INSERT ON project_members FOR EACH ROW EXECUTE FUNCTION reject_member()`); err != nil {
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
	if _, err := s.Pool.Exec(ctx, `DROP TRIGGER reject_member ON project_members; DROP FUNCTION reject_member()`); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := s.Pool.Exec(ctx, `INSERT INTO project_invitations (id,project_id,created_by,token_hash,created_at,expires_at) SELECT md5(n::text)::uuid,$1,$2,sha256(n::text::bytea),$3::timestamptz-interval '2 hours',$3::timestamptz-interval '1 hour' FROM generate_series(1,120) n`, project.ID, admin.UserID, now); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		return tx.CreateInvitation(ctx, newStoredInvitation(project, admin, "fresh"))
	}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_invitations WHERE expires_at<=$1`, now).Scan(&count); err != nil || count != 20 {
		t.Fatalf("cleanup: %d %v", count, err)
	}
}

func TestMembershipStorageOperationalFailures(t *testing.T) {
	for _, phase := range []string{"private-project", "project-member", "project-access", "write-access", "accessible", "members", "target-member", "admin-count", "set-role", "remove", "add", "inspect", "lock", "create", "list-invites", "revoke", "consume"} {
		t.Run(phase, func(t *testing.T) {
			s, admin, member, project := membershipFixture(t)
			ctx := context.Background()
			invite := newStoredInvitation(project, admin, "fault")
			table := "project_members"
			if phase == "private-project" {
				table = "projects"
			}
			if phase == "inspect" || phase == "lock" || phase == "create" || phase == "list-invites" || phase == "revoke" || phase == "consume" {
				table = "project_invitations"
			}
			if _, err := s.Pool.Exec(ctx, "DROP TABLE "+table); err != nil {
				t.Fatal(err)
			}
			var err error
			switch phase {
			case "private-project":
				_, err = s.CreatePrivateProject(ctx, admin, uuid.NewString(), "Missing", "https://example.com/missing")
			case "project-member", "project-access", "accessible", "members", "inspect", "list-invites":
				err = s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
					var err error
					switch phase {
					case "project-member":
						_, err = snapshot.DirectProjectMember(ctx, admin.UserID, project.ID)
					case "project-access":
						_, err = snapshot.ProjectAccess(ctx, admin, project.ID)
					case "accessible":
						_, err = snapshot.AccessibleProjects(ctx, admin, Page{Limit: 1})
					case "members":
						_, err = snapshot.ProjectParticipants(ctx, project.ID)
					case "inspect":
						_, err = snapshot.Invitation(ctx, invite.TokenHash)
					case "list-invites":
						_, err = snapshot.Invitations(ctx, project.ID, time.Now())
					}
					return err
				})
			default:
				err = s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
					var err error
					switch phase {
					case "write-access":
						_, err = tx.ProjectAccess(ctx, admin)
					case "target-member":
						_, err = tx.DirectProjectMember(ctx, member.UserID)
					case "admin-count":
						_, err = tx.AdminCount(ctx)
					case "set-role":
						_, err = tx.SetMemberRole(ctx, admin.UserID, core.ProjectMemberRole)
					case "remove":
						err = tx.RemoveMember(ctx, member.UserID)
					case "add":
						_, err = tx.AddInvitedMember(ctx, member.UserID)
					case "lock":
						_, err = tx.LockInvitation(ctx, invite.TokenHash)
					case "create":
						err = tx.CreateInvitation(ctx, invite)
					case "revoke":
						err = tx.RevokeInvitation(ctx, invite.ID, time.Now())
					case "consume":
						err = tx.ConsumeInvitation(ctx, invite.ID, member.UserID, time.Now())
					}
					return err
				})
			}
			var databaseError *Error
			if !errors.As(err, &databaseError) || strings.Contains(err.Error(), "SELECT") {
				t.Fatalf("missing chain or leaked SQL: %v", err)
			}
		})
	}
	s, admin, _, _ := membershipFixture(t)
	s.Close()
	if _, err := s.CreatePrivateProject(context.Background(), admin, uuid.NewString(), "Closed", "https://example.com/closed"); err == nil {
		t.Fatal("closed pool accepted")
	}
}

func TestProjectParticipantsKeepGrantFactsAndRequireCanonicalProfiles(t *testing.T) {
	s, admin, member, project := membershipFixture(t)
	ctx := context.Background()
	var direct core.ProjectMember
	if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		var err error
		direct, err = tx.AddInvitedMember(ctx, member.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	name, email, avatar := "  Participant  ", "participant@example.test", "https://example.test/avatar"
	if _, err := s.Pool.Exec(ctx, `UPDATE users SET name=$2,email=$3,avatar_url=$4 WHERE id=$1`, admin.UserID, name, email, avatar); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		people, err := snapshot.ProjectParticipants(ctx, project.ID)
		if err != nil {
			return err
		}
		if len(people) != 2 || people[0].UserID != admin.UserID || people[1].UserID != member.UserID {
			t.Fatalf("deduplicated ordered participants: %#v", people)
		}
		if !reflect.DeepEqual(people[0].Profile, core.ProjectParticipantProfile{Name: &name, Email: &email, AvatarURL: &avatar}) || people[0].EffectiveRole != core.ProjectAdmin {
			t.Fatalf("canonical profile: %#v", people[0])
		}
		if !reflect.DeepEqual(people[1], core.ProjectParticipant{UserID: member.UserID, Profile: core.ProjectParticipantProfile{}, EffectiveRole: core.ProjectMemberRole, DirectGrant: &direct.Grant}) {
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
	err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		people, err := snapshot.ProjectParticipants(ctx, project.ID)
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
