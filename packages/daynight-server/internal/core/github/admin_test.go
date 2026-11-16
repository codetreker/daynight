package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

const adminApp = "00000000-0000-4000-8000-000000000001"
const adminUser = "00000000-0000-4000-8000-000000000002"
const otherAdmin = "00000000-0000-4000-8000-000000000003"
const adminInvite = "00000000-0000-4000-8000-000000000004"

type adminDAOTest struct {
	store.GitHubAppAdminWriter
	app         func(context.Context, string) (githubpr.AppIdentity, error)
	member      func(context.Context, string, string) (githubpr.AdminMembership, error)
	admins      func(context.Context, string, store.Page) (store.GitHubAppAdminPage, error)
	invitation  func(context.Context, string, string) (githubpr.AppInvitation, error)
	byHash      func(context.Context, []byte) (githubpr.AppInvitation, error)
	invitations func(context.Context, string, store.Page) (store.GitHubAppInvitationPage, error)
	clock       func(context.Context) (time.Time, error)
	create      func(context.Context, githubpr.AppInvitation, []byte) error
	revoke      func(context.Context, string, string, time.Time) error
	consume     func(context.Context, string, string, string, time.Time) error
	add         func(context.Context, string, string) (githubpr.AdminMembership, error)
	remove      func(context.Context, string, string, int64) error
	count       func(context.Context, string) (int64, error)
}

func (d adminDAOTest) App(c context.Context, a string) (githubpr.AppIdentity, error) {
	return d.app(c, a)
}
func (d adminDAOTest) Membership(c context.Context, a, u string) (githubpr.AdminMembership, error) {
	return d.member(c, a, u)
}
func (d adminDAOTest) AdminPage(c context.Context, a string, p store.Page) (store.GitHubAppAdminPage, error) {
	return d.admins(c, a, p)
}
func (d adminDAOTest) Invitation(c context.Context, a, i string) (githubpr.AppInvitation, error) {
	return d.invitation(c, a, i)
}
func (d adminDAOTest) InvitationByHash(c context.Context, h []byte) (githubpr.AppInvitation, error) {
	return d.byHash(c, h)
}
func (d adminDAOTest) InvitationPage(c context.Context, a string, p store.Page) (store.GitHubAppInvitationPage, error) {
	return d.invitations(c, a, p)
}
func (d adminDAOTest) ObservedAt(c context.Context) (time.Time, error) { return d.clock(c) }
func (d adminDAOTest) CreateInvitation(c context.Context, i githubpr.AppInvitation, h []byte) error {
	return d.create(c, i, h)
}
func (d adminDAOTest) RevokeInvitation(c context.Context, a, i string, n time.Time) error {
	return d.revoke(c, a, i, n)
}
func (d adminDAOTest) ConsumeInvitation(c context.Context, a, i, u string, n time.Time) error {
	return d.consume(c, a, i, u, n)
}
func (d adminDAOTest) AddAdmin(c context.Context, a, u string) (githubpr.AdminMembership, error) {
	return d.add(c, a, u)
}
func (d adminDAOTest) RemoveAdmin(c context.Context, a, u string, v int64) error {
	return d.remove(c, a, u, v)
}
func (d adminDAOTest) CountAdmins(c context.Context, a string) (int64, error) { return d.count(c, a) }

var adminNow = time.Date(2026, 11, 16, 1, 2, 3, 0, time.UTC)
var adminPrincipal = model.Principal{UserID: adminUser, Kind: model.PATCredential, CredentialID: adminUser}

func normalAdminDAO() adminDAOTest {
	return adminDAOTest{
		app: func(context.Context, string) (githubpr.AppIdentity, error) {
			return githubpr.AppIdentity{ID: adminApp, Name: "Application", GitHubAppID: 123}, nil
		},
		member: func(_ context.Context, a, u string) (githubpr.AdminMembership, error) {
			return githubpr.AdminMembership{AppID: a, UserID: u, Version: 5, CreatedAt: adminNow, UpdatedAt: adminNow}, nil
		},
		clock: func(context.Context) (time.Time, error) { return adminNow, nil },
	}
}
func normalInvitation() githubpr.AppInvitation {
	return githubpr.AppInvitation{ID: adminInvite, AppID: adminApp, CreatedBy: adminUser, IssuerMembershipVersion: 5, CreatedAt: adminNow, ExpiresAt: adminNow.Add(7 * 24 * time.Hour)}
}
func faultCodeAdmin(t *testing.T, err error, want string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != want {
		t.Fatalf("error=%v want %s", err, want)
	}
}

func TestAdminInputAndPagination(t *testing.T) {
	for _, tc := range []struct {
		p             model.Principal
		app, expected string
		want          string
	}{
		{adminPrincipal, adminApp, adminUser, ""}, {model.Principal{}, adminApp, adminUser, "unauthenticated"}, {adminPrincipal, adminApp, otherAdmin, "identity_mismatch"}, {adminPrincipal, "bad", adminUser, "invalid_input"},
	} {
		err := ValidateAdminWrite(tc.p, tc.app, tc.expected)
		if tc.want == "" {
			if err != nil {
				t.Fatal(err)
			}
		} else {
			faultCodeAdmin(t, err, tc.want)
		}
	}
	if ValidateAdminID(adminUser) != nil || ValidateAdminID("bad") == nil {
		t.Fatal("ID validation")
	}
	d := normalAdminDAO()
	d.admins = func(_ context.Context, a string, p store.Page) (store.GitHubAppAdminPage, error) {
		if a != adminApp || p.Limit != 1 {
			t.Fatal("page input")
		}
		return store.GitHubAppAdminPage{Items: []githubpr.AdminProfile{{AdminMembership: githubpr.AdminMembership{UserID: adminUser, CreatedAt: adminNow}}}, HasMore: true}, nil
	}
	page, err := ListAdmins(context.Background(), d, adminPrincipal, adminApp, ListAppsInput{Limit: 1})
	if err != nil || page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatalf("page=%+v %v", page, err)
	}
	d.admins = func(_ context.Context, _ string, p store.Page) (store.GitHubAppAdminPage, error) {
		if p.After == nil || p.After.ID != adminUser {
			t.Fatal("cursor position")
		}
		return store.GitHubAppAdminPage{}, nil
	}
	page, err = ListAdmins(context.Background(), d, adminPrincipal, adminApp, ListAppsInput{Limit: 1, Cursor: *page.NextCursor})
	if err != nil || page.Items == nil || page.NextCursor != nil {
		t.Fatalf("empty %+v %v", page, err)
	}
	if _, err = ListAdmins(context.Background(), d, adminPrincipal, otherAdmin, ListAppsInput{Cursor: "bad"}); err == nil {
		t.Fatal("invalid cursor")
	}
	if _, err = ListAdmins(context.Background(), d, model.Principal{}, adminApp, ListAppsInput{}); err == nil {
		t.Fatal("anonymous")
	}
}

func TestAdminRemovalRules(t *testing.T) {
	ctx := context.Background()
	for _, self := range []bool{false, true} {
		d := normalAdminDAO()
		user := otherAdmin
		if self {
			user = adminUser
		}
		d.count = func(context.Context, string) (int64, error) { return 2, nil }
		d.remove = func(_ context.Context, a, u string, v int64) error {
			if a != adminApp || u != user || v != 5 {
				t.Fatal("exact deletion")
			}
			return nil
		}
		out, err := RemoveAdmin(ctx, d, adminPrincipal, adminApp, user, 5)
		if err != nil || !out.Removed || out.ActorIsAdmin == self {
			t.Fatalf("%+v %v", out, err)
		}
	}
	d := normalAdminDAO()
	d.count = func(context.Context, string) (int64, error) { return 1, nil }
	_, err := RemoveAdmin(ctx, d, adminPrincipal, adminApp, adminUser, 5)
	faultCodeAdmin(t, err, "last_admin")
	_, err = RemoveAdmin(ctx, d, adminPrincipal, adminApp, adminUser, 4)
	faultCodeAdmin(t, err, "version_conflict")
	boom := errors.New("store")
	for _, stage := range []string{"app", "actor", "target", "count", "remove"} {
		t.Run(stage, func(t *testing.T) {
			d := normalAdminDAO()
			d.count = func(context.Context, string) (int64, error) { return 2, nil }
			d.remove = func(context.Context, string, string, int64) error { return nil }
			switch stage {
			case "app":
				d.app = func(context.Context, string) (githubpr.AppIdentity, error) { return githubpr.AppIdentity{}, boom }
			case "actor":
				d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
					return githubpr.AdminMembership{}, boom
				}
			case "target":
				d.member = func(_ context.Context, a, u string) (githubpr.AdminMembership, error) {
					if u == otherAdmin {
						return githubpr.AdminMembership{}, boom
					}
					return githubpr.AdminMembership{Version: 5}, nil
				}
			case "count":
				d.count = func(context.Context, string) (int64, error) { return 0, boom }
			case "remove":
				d.remove = func(context.Context, string, string, int64) error { return boom }
			}
			_, err := RemoveAdmin(ctx, d, adminPrincipal, adminApp, otherAdmin, 5)
			if !errors.Is(err, boom) {
				t.Fatal(err)
			}
		})
	}
	d = normalAdminDAO()
	d.app = func(context.Context, string) (githubpr.AppIdentity, error) {
		return githubpr.AppIdentity{}, model.ErrNotFound
	}
	_, err = RequireAppAdmin(ctx, d, adminPrincipal, adminApp)
	faultCodeAdmin(t, err, "not_found")
}

func TestCreateAdminInvitationHashAndLifetime(t *testing.T) {
	d := normalAdminDAO()
	var saved githubpr.AppInvitation
	var hash []byte
	d.create = func(_ context.Context, i githubpr.AppInvitation, h []byte) error { saved = i; hash = h; return nil }
	out, err := CreateAdminInvitation(context.Background(), d, adminPrincipal, adminApp)
	if err != nil || !secretutil.Valid(out.Secret, adminInvitationPrefix) || string(hash) != string(secretutil.Hash(out.Secret)) || len(hash) != 32 || saved.IssuerMembershipVersion != 5 || saved.ExpiresAt.Sub(saved.CreatedAt) != 7*24*time.Hour || !out.Invitation.Available {
		t.Fatalf("%+v %v", out, err)
	}
	if err := ValidateAdminInvitation(adminPrincipal, out.Secret); err != nil {
		t.Fatal(err)
	}
	faultCodeAdmin(t, ValidateAdminInvitation(adminPrincipal, "bad"), "invitation_unavailable")
	faultCodeAdmin(t, ValidateAdminInvitation(model.Principal{}, out.Secret), "unauthenticated")
	boom := errors.New("store")
	for _, stage := range []string{"permission", "clock", "create"} {
		d := normalAdminDAO()
		d.create = func(context.Context, githubpr.AppInvitation, []byte) error { return boom }
		if stage == "permission" {
			d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
				return githubpr.AdminMembership{}, boom
			}
		}
		if stage == "clock" {
			d.clock = func(context.Context) (time.Time, error) { return time.Time{}, boom }
		}
		_, err := CreateAdminInvitation(context.Background(), d, adminPrincipal, adminApp)
		if !errors.Is(err, boom) {
			t.Fatal(stage, err)
		}
	}
}

func TestAdminListPermissionAndQueryFailures(t *testing.T) {
	boom := errors.New("query failed")
	for _, stage := range []string{"permission", "query"} {
		d := normalAdminDAO()
		d.admins = func(context.Context, string, store.Page) (store.GitHubAppAdminPage, error) {
			return store.GitHubAppAdminPage{}, boom
		}
		if stage == "permission" {
			d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
				return githubpr.AdminMembership{}, boom
			}
		}
		if _, err := ListAdmins(context.Background(), d, adminPrincipal, adminApp, ListAppsInput{}); !errors.Is(err, boom) {
			t.Fatalf("%s: %v", stage, err)
		}
	}
}
