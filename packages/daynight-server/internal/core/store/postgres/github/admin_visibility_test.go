package github_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAdminVisibilityAndInvitationAvailability(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	app, invite, outsider := uuid.NewString(), uuid.NewString(), uuid.NewString()
	hash := []byte("01234567890123456789012345678901")
	queries := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','Remote','remote','key','secret')`, []any{app}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{app, actor}},
		{`INSERT INTO github_app_admin_invitations(id,app_resource_id,token_hash,created_by,issuer_membership_version,created_at,expires_at) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 hour')`, []any{invite, app, hash, actor}},
	}
	for _, q := range queries {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	check := func(revoked bool) {
		t.Helper()
		if err := db.ReadGitHubAppAdmins(ctx, func(d store.GitHubAppAdminReader) error {
			v, ok := d.(store.GitHubAppAdminVisibilityDAO)
			if !ok {
				t.Fatal("visibility capability missing")
			}
			if err := v.AppAdminVisibility(ctx, app, actor); err != nil {
				return err
			}
			if err := v.AdminMembershipVisibility(ctx, app, actor); err != nil {
				return err
			}
			if err := v.AdminInvitationVisibility(ctx, app, invite); err != nil {
				return err
			}
			for _, err := range []error{v.AppAdminVisibility(ctx, app, outsider), v.AppAdminVisibility(ctx, uuid.NewString(), actor), v.AdminMembershipVisibility(ctx, app, outsider), v.AdminInvitationVisibility(ctx, app, uuid.NewString())} {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("missing target: %v", err)
				}
			}
			ref, err := v.AvailableAdminInvitation(ctx, hash)
			if revoked {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("revoked %v", err)
				}
			} else if err != nil || ref.ID != invite || ref.AppID != app || ref.ExpiresAt.IsZero() {
				t.Fatalf("available %+v %v", ref, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	check(false)
	if _, err := db.Pool.Exec(ctx, `UPDATE github_app_admin_invitations SET revoked_at=now() WHERE id=$1`, invite); err != nil {
		t.Fatal(err)
	}
	check(true)
	if _, err := db.Pool.Exec(ctx, `UPDATE github_app_admin_invitations SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1`, invite); err != nil {
		t.Fatal(err)
	}
	check(true)
}
