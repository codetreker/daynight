package github_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func appAdminFixture(t *testing.T) (*postgres.Store, string, string, string) {
	t.Helper()
	db, actor := dbFixture(t)
	other, appID := uuid.NewString(), uuid.NewString()
	for _, id := range []string{actor, other} {
		if _, err := db.Pool.Exec(t.Context(), `INSERT INTO users(id,uniauth_id,name,email,avatar_url,created_at,updated_at) VALUES($1,$2,'A name','a@example.test','https://example.test/a',now(),now())`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	completion, err := db.WriteGitHubApp(t.Context(), func(w store.GitHubAppWriteDAO) error {
		_, err := w.Create(t.Context(), store.GitHubAppCreate{ID: appID, GitHubAppID: 123, Name: "Automation", GitHubName: "Remote", GitHubSlug: "remote", CreatorUserID: actor, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}})
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("create fixture: %+v %v", completion, err)
	}
	return db, appID, actor, other
}

func adminWrite(t *testing.T, db *postgres.Store, appID string, operation func(store.GitHubAppAdminWriter) error) {
	t.Helper()
	completion, err := db.WriteGitHubAppAdmins(t.Context(), appID, operation)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("administrator write: %+v %v", completion, err)
	}
}

func TestAppAdminPersistenceProfilesAndVersions(t *testing.T) {
	db, appID, _, other := appAdminFixture(t)
	ctx := t.Context()
	var added githubpr.AdminMembership
	adminWrite(t, db, appID, func(w store.GitHubAppAdminWriter) error {
		app, err := w.App(ctx, appID)
		if err != nil || app.ID != appID || app.Name != "Automation" || app.GitHubAppID != 123 {
			t.Fatalf("minimal identity: %+v %v", app, err)
		}
		clock, err := w.ObservedAt(ctx)
		if err != nil || clock.Before(time.Now().Add(-time.Minute)) || clock.After(time.Now().Add(time.Minute)) {
			t.Fatalf("clock: %v %v", clock, err)
		}
		added, err = w.AddAdmin(ctx, appID, other)
		if err != nil || added.UserID != other || added.AppID != appID || added.Version < 1 || added.CreatedAt.IsZero() {
			t.Fatalf("add: %+v %v", added, err)
		}
		count, err := w.CountAdmins(ctx, appID)
		if err != nil || count != 2 {
			t.Fatalf("count: %d %v", count, err)
		}
		return nil
	})
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		got, err := r.Membership(ctx, appID, other)
		if err != nil || got != added {
			t.Fatalf("membership readback: %+v %v", got, err)
		}
		for _, limit := range []int{0, 101} {
			if _, err := r.AdminPage(ctx, appID, store.Page{Limit: limit}); err == nil {
				t.Fatalf("invalid limit %d", limit)
			}
		}
		first, err := r.AdminPage(ctx, appID, store.Page{Limit: 1})
		if err != nil || len(first.Items) != 1 || !first.HasMore || first.Items[0].Name == nil || *first.Items[0].Name != "A name" || first.Items[0].Email == nil || first.Items[0].AvatarURL == nil {
			t.Fatalf("profile first page: %+v %v", first, err)
		}
		last := first.Items[0]
		second, err := r.AdminPage(ctx, appID, store.Page{Limit: 1, After: &store.Position{CreatedAt: last.CreatedAt, ID: last.UserID}})
		if err != nil || len(second.Items) != 1 || second.HasMore || second.Items[0].UserID == last.UserID {
			t.Fatalf("second page: %+v %v", second, err)
		}
		empty, err := r.AdminPage(ctx, uuid.NewString(), store.Page{Limit: 1})
		if err != nil || empty.Items == nil || len(empty.Items) != 0 {
			t.Fatalf("empty: %+v %v", empty, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name      string
		operation func(store.GitHubAppAdminWriter) error
	}{
		{"missing account", func(w store.GitHubAppAdminWriter) error {
			_, err := w.AddAdmin(ctx, appID, uuid.NewString())
			return err
		}},
		{"duplicate", func(w store.GitHubAppAdminWriter) error { _, err := w.AddAdmin(ctx, appID, other); return err }},
		{"stale removal", func(w store.GitHubAppAdminWriter) error { return w.RemoveAdmin(ctx, appID, other, added.Version+1) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, err := db.WriteGitHubAppAdmins(ctx, appID, test.operation)
			if err == nil || c.Outcome != store.TransactionNotCommitted {
				t.Fatalf("expected rollback: %+v %v", c, err)
			}
		})
	}
	adminWrite(t, db, appID, func(w store.GitHubAppAdminWriter) error {
		if err := w.RemoveAdmin(ctx, appID, other, added.Version); err != nil {
			return err
		}
		again, err := w.AddAdmin(ctx, appID, other)
		if err != nil || again.Version <= added.Version {
			t.Fatalf("rejoined version: old=%d new=%+v err=%v", added.Version, again, err)
		}
		return nil
	})
	var apps, teams, projects int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM github_app_admins WHERE app_resource_id=$1),(SELECT count(*) FROM team_members WHERE user_id=$2),(SELECT count(*) FROM project_grants WHERE user_id=$2)`, appID, other).Scan(&apps, &teams, &projects); err != nil || apps != 2 || teams != 0 || projects != 0 {
		t.Fatalf("independent App role: %d %d %d %v", apps, teams, projects, err)
	}
}

func TestAppInvitationStorageMetadataAndIssuerVersion(t *testing.T) {
	db, appID, actor, other := appAdminFixture(t)
	ctx := t.Context()
	var invitations []githubpr.AppInvitation
	var hashes [][32]byte
	var issuer githubpr.AdminMembership
	adminWrite(t, db, appID, func(w store.GitHubAppAdminWriter) error {
		var err error
		issuer, err = w.Membership(ctx, appID, actor)
		if err != nil {
			return err
		}
		if _, err = w.AddAdmin(ctx, appID, other); err != nil {
			return err
		}
		now, err := w.ObservedAt(ctx)
		if err != nil {
			return err
		}
		for n := 0; n < 3; n++ {
			i := githubpr.AppInvitation{ID: uuid.NewString(), AppID: appID, CreatedBy: actor, IssuerMembershipVersion: issuer.Version, CreatedAt: now.Add(time.Duration(n) * time.Second), ExpiresAt: now.Add(7 * 24 * time.Hour)}
			hash := sha256.Sum256([]byte(i.ID))
			if err := w.CreateInvitation(ctx, i, hash[:]); err != nil {
				return err
			}
			invitations = append(invitations, i)
			hashes = append(hashes, hash)
		}
		return nil
	})
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		got, err := r.InvitationByHash(ctx, hashes[0][:])
		if err != nil || got.ID != invitations[0].ID || got.IssuerMembershipVersion != issuer.Version || got.ConsumedAt != nil || got.RevokedAt != nil {
			t.Fatalf("hash lookup: %+v %v", got, err)
		}
		for _, limit := range []int{0, 101} {
			if _, err := r.InvitationPage(ctx, appID, store.Page{Limit: limit}); err == nil {
				t.Fatalf("invalid limit %d", limit)
			}
		}
		first, err := r.InvitationPage(ctx, appID, store.Page{Limit: 1})
		if err != nil || len(first.Items) != 1 || !first.HasMore || first.Items[0].CurrentIssuerMembershipVersion == nil || *first.Items[0].CurrentIssuerMembershipVersion != issuer.Version {
			t.Fatalf("first page: %+v %v", first, err)
		}
		last := first.Items[0].Invitation
		second, err := r.InvitationPage(ctx, appID, store.Page{Limit: 2, After: &store.Position{CreatedAt: last.CreatedAt, ID: last.ID}})
		if err != nil || len(second.Items) != 2 || second.HasMore || second.Items[0].Invitation.ID == last.ID {
			t.Fatalf("second page: %+v %v", second, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	adminWrite(t, db, appID, func(w store.GitHubAppAdminWriter) error {
		now, err := w.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if err = w.RevokeInvitation(ctx, appID, invitations[0].ID, now); err != nil {
			return err
		}
		if err = w.ConsumeInvitation(ctx, appID, invitations[1].ID, other, now); err != nil {
			return err
		}
		if err = w.RemoveAdmin(ctx, appID, actor, issuer.Version); err != nil {
			return err
		}
		return nil
	})
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		revoked, err := r.Invitation(ctx, appID, invitations[0].ID)
		if err != nil || revoked.RevokedAt == nil {
			t.Fatalf("revocation readback: %+v %v", revoked, err)
		}
		consumed, err := r.Invitation(ctx, appID, invitations[1].ID)
		if err != nil || consumed.ConsumedAt == nil || consumed.ConsumedBy == nil || *consumed.ConsumedBy != other {
			t.Fatalf("consumption readback: %+v %v", consumed, err)
		}
		page, err := r.InvitationPage(ctx, appID, store.Page{Limit: 10})
		if err != nil || len(page.Items) != 3 {
			t.Fatalf("page: %+v %v", page, err)
		}
		for _, i := range page.Items {
			if i.CurrentIssuerMembershipVersion != nil {
				t.Fatal("removed issuer still has membership")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	adminWrite(t, db, appID, func(w store.GitHubAppAdminWriter) error { _, err := w.AddAdmin(ctx, appID, actor); return err })
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		page, err := r.InvitationPage(ctx, appID, store.Page{Limit: 10})
		if err != nil {
			return err
		}
		for _, i := range page.Items {
			if i.CurrentIssuerMembershipVersion == nil || *i.CurrentIssuerMembershipVersion == i.Invitation.IssuerMembershipVersion {
				t.Fatalf("readded issuer revived old invitation: %+v", i)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func(store.GitHubAppAdminWriter) error{
		func(w store.GitHubAppAdminWriter) error {
			return w.RevokeInvitation(ctx, appID, invitations[0].ID, time.Now())
		},
		func(w store.GitHubAppAdminWriter) error {
			return w.ConsumeInvitation(ctx, appID, invitations[0].ID, other, time.Now())
		},
		func(w store.GitHubAppAdminWriter) error {
			return w.RevokeInvitation(ctx, appID, invitations[1].ID, time.Now())
		},
		func(w store.GitHubAppAdminWriter) error {
			return w.ConsumeInvitation(ctx, appID, invitations[1].ID, other, time.Now())
		},
	} {
		c, err := db.WriteGitHubAppAdmins(ctx, appID, operation)
		if !errors.Is(err, model.ErrNotFound) || c.Outcome != store.TransactionNotCommitted {
			t.Fatalf("terminal invitation mutation: %+v %v", c, err)
		}
	}
}

func TestAppAdminDAOBoundsAndDatabaseFailures(t *testing.T) {
	db, appID, _, other := appAdminFixture(t)
	ctx := t.Context()
	tx := begin(t, db, pgx.TxOptions{})
	r, w := github.NewAppAdminReader(tx), github.NewAppAdminWriter(tx, appID)
	wrong := uuid.NewString()
	i := githubpr.AppInvitation{ID: uuid.NewString(), AppID: wrong}
	for _, err := range []error{w.CreateInvitation(ctx, i, []byte("hash")), w.RevokeInvitation(ctx, wrong, i.ID, time.Now()), w.ConsumeInvitation(ctx, wrong, i.ID, other, time.Now()), w.RemoveAdmin(ctx, wrong, other, 1)} {
		if err == nil {
			t.Fatal("cross-App mutation accepted")
		}
	}
	if _, err := w.AddAdmin(ctx, wrong, other); err == nil {
		t.Fatal("cross-App addition accepted")
	}
	if _, err := w.CountAdmins(ctx, wrong); err == nil {
		t.Fatal("cross-App administrator count accepted")
	}
	if _, err := r.App(ctx, wrong); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing App: %v", err)
	}
	if _, err := r.Membership(ctx, appID, other); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing member: %v", err)
	}
	if _, err := r.Invitation(ctx, appID, i.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing invitation: %v", err)
	}
	if _, err := r.InvitationByHash(ctx, []byte("missing")); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing hash: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE github_apps SET private_key_pem=NULL WHERE id=$1`, appID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.App(ctx, appID); err == nil {
		t.Fatal("missing live credentials must fail")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	for name, operation := range map[string]func() error{
		"app":         func() error { _, err := r.App(cancelled, appID); return err },
		"membership":  func() error { _, err := r.Membership(cancelled, appID, other); return err },
		"clock":       func() error { _, err := r.ObservedAt(cancelled); return err },
		"admins":      func() error { _, err := r.AdminPage(cancelled, appID, store.Page{Limit: 1}); return err },
		"invitation":  func() error { _, err := r.Invitation(cancelled, appID, i.ID); return err },
		"hash":        func() error { _, err := r.InvitationByHash(cancelled, []byte("hash")); return err },
		"invitations": func() error { _, err := r.InvitationPage(cancelled, appID, store.Page{Limit: 1}); return err },
		"add":         func() error { _, err := w.AddAdmin(cancelled, appID, other); return err },
		"remove":      func() error { return w.RemoveAdmin(cancelled, appID, other, 1) },
		"count":       func() error { _, err := w.CountAdmins(cancelled, appID); return err },
		"create":      func() error { i.AppID = appID; return w.CreateInvitation(cancelled, i, []byte("hash")) },
	} {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Fatal("closed transaction operation succeeded")
			}
		})
	}
}
