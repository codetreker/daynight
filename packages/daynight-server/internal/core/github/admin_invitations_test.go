package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func invitationDAOTest() adminDAOTest {
	d := normalAdminDAO()
	d.byHash = func(context.Context, []byte) (githubpr.AppInvitation, error) { return normalInvitation(), nil }
	return d
}

func TestAdminInvitationInspectAndAccept(t *testing.T) {
	ctx := context.Background()
	d := invitationDAOTest()
	out, err := InspectAdminInvitation(ctx, d, adminPrincipal, "token")
	if err != nil || out.Membership == nil || out.Membership.Version != 5 || out.App.ID != adminApp || !out.ExpiresAt.Equal(normalInvitation().ExpiresAt) {
		t.Fatalf("%+v %v", out, err)
	}
	accepted, err := AcceptAdminInvitation(ctx, d, adminPrincipal, "token")
	if err != nil || accepted.Joined || accepted.Membership.Version != 5 {
		t.Fatalf("%+v %v", accepted, err)
	}
	p := model.Principal{UserID: otherAdmin, Kind: model.PATCredential, CredentialID: otherAdmin}
	d.member = func(_ context.Context, a, u string) (githubpr.AdminMembership, error) {
		if u == otherAdmin {
			return githubpr.AdminMembership{}, model.ErrNotFound
		}
		return githubpr.AdminMembership{Version: 5}, nil
	}
	out, err = InspectAdminInvitation(ctx, d, p, "token")
	if err != nil || out.Membership != nil {
		t.Fatalf("%+v %v", out, err)
	}
	added, consumed := 0, 0
	d.add = func(_ context.Context, a, u string) (githubpr.AdminMembership, error) {
		added++
		if a != adminApp || u != otherAdmin {
			t.Fatal("add identity")
		}
		return githubpr.AdminMembership{AppID: a, UserID: u, Version: 9}, nil
	}
	d.consume = func(_ context.Context, a, i, u string, n time.Time) error {
		consumed++
		if a != adminApp || i != adminInvite || u != otherAdmin || !n.Equal(adminNow) {
			t.Fatal("consume identity")
		}
		return nil
	}
	accepted, err = AcceptAdminInvitation(ctx, d, p, "token")
	if err != nil || !accepted.Joined || accepted.Membership.Version != 9 || added != 1 || consumed != 1 {
		t.Fatalf("%+v %v writes %d/%d", accepted, err, added, consumed)
	}
}

func TestAdminInvitationUnavailableBeforeExistingMembership(t *testing.T) {
	for _, kind := range []string{"revoked", "consumed", "expired", "issuer_removed", "issuer_rejoined", "app_deleted", "missing"} {
		t.Run(kind, func(t *testing.T) {
			d := invitationDAOTest()
			i := normalInvitation()
			switch kind {
			case "revoked":
				i.RevokedAt = &adminNow
			case "consumed":
				i.ConsumedAt = &adminNow
			case "expired":
				i.ExpiresAt = adminNow
			case "issuer_removed":
				d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
					return githubpr.AdminMembership{}, model.ErrNotFound
				}
			case "issuer_rejoined":
				d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
					return githubpr.AdminMembership{Version: 6}, nil
				}
			case "app_deleted":
				d.app = func(context.Context, string) (githubpr.AppIdentity, error) {
					return githubpr.AppIdentity{}, model.ErrNotFound
				}
			}
			d.byHash = func(context.Context, []byte) (githubpr.AppInvitation, error) {
				if kind == "missing" {
					return githubpr.AppInvitation{}, model.ErrNotFound
				}
				return i, nil
			}
			_, err := InspectAdminInvitation(context.Background(), d, adminPrincipal, "token")
			faultCodeAdmin(t, err, "invitation_unavailable")
			_, err = AcceptAdminInvitation(context.Background(), d, adminPrincipal, "token")
			faultCodeAdmin(t, err, "invitation_unavailable")
		})
	}
}

func TestAdminInvitationStorageErrors(t *testing.T) {
	boom := errors.New("database failure")
	for _, stage := range []string{"lookup", "app", "issuer", "clock", "member", "add", "second_clock", "consume"} {
		t.Run(stage, func(t *testing.T) {
			d := invitationDAOTest()
			d.member = func(_ context.Context, a, u string) (githubpr.AdminMembership, error) {
				if u == otherAdmin {
					return githubpr.AdminMembership{}, model.ErrNotFound
				}
				return githubpr.AdminMembership{Version: 5}, nil
			}
			d.add = func(context.Context, string, string) (githubpr.AdminMembership, error) {
				return githubpr.AdminMembership{Version: 6}, nil
			}
			d.consume = func(context.Context, string, string, string, time.Time) error { return nil }
			switch stage {
			case "lookup":
				d.byHash = func(context.Context, []byte) (githubpr.AppInvitation, error) { return githubpr.AppInvitation{}, boom }
			case "app":
				d.app = func(context.Context, string) (githubpr.AppIdentity, error) { return githubpr.AppIdentity{}, boom }
			case "issuer":
				d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
					return githubpr.AdminMembership{}, boom
				}
			case "clock":
				d.clock = func(context.Context) (time.Time, error) { return time.Time{}, boom }
			case "member":
				d.member = func(_ context.Context, a, u string) (githubpr.AdminMembership, error) {
					if u == otherAdmin {
						return githubpr.AdminMembership{}, boom
					}
					return githubpr.AdminMembership{Version: 5}, nil
				}
			case "add":
				d.add = func(context.Context, string, string) (githubpr.AdminMembership, error) {
					return githubpr.AdminMembership{}, boom
				}
			case "second_clock":
				calls := 0
				d.clock = func(context.Context) (time.Time, error) {
					calls++
					if calls == 2 {
						return time.Time{}, boom
					}
					return adminNow, nil
				}
			case "consume":
				d.consume = func(context.Context, string, string, string, time.Time) error { return boom }
			}
			_, err := AcceptAdminInvitation(context.Background(), d, model.Principal{UserID: otherAdmin, Kind: model.PATCredential, CredentialID: otherAdmin}, "token")
			if !errors.Is(err, boom) {
				t.Fatal(stage, err)
			}
			if stage == "member" {
				_, err = InspectAdminInvitation(context.Background(), d, model.Principal{UserID: otherAdmin, Kind: model.PATCredential, CredentialID: otherAdmin}, "token")
				if !errors.Is(err, boom) {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestAdminInvitationListDerivedAvailabilityAndCursor(t *testing.T) {
	d := normalAdminDAO()
	version := int64(5)
	d.invitations = func(_ context.Context, a string, p store.Page) (store.GitHubAppInvitationPage, error) {
		if p.Limit != 25 || a != adminApp {
			t.Fatal("page input")
		}
		return store.GitHubAppInvitationPage{Items: []store.GitHubAppInvitationRecord{{Invitation: normalInvitation(), CurrentIssuerMembershipVersion: &version}, {Invitation: normalInvitation()}}, HasMore: true}, nil
	}
	out, err := ListAdminInvitations(context.Background(), d, adminPrincipal, adminApp, ListAppsInput{})
	if err != nil || out.NextCursor == nil || len(out.Items) != 2 || !out.Items[0].Available || out.Items[1].Available {
		t.Fatalf("%+v %v", out, err)
	}
	_, _, err = adminListPage(adminPrincipal, otherAdmin, "github_app_admin_invitations", ListAppsInput{Cursor: *out.NextCursor})
	if err == nil {
		t.Fatal("cross-App cursor accepted")
	}
	_, _, err = adminListPage(model.Principal{UserID: otherAdmin, Kind: model.PATCredential, CredentialID: otherAdmin}, adminApp, "github_app_admin_invitations", ListAppsInput{Cursor: *out.NextCursor})
	if err == nil {
		t.Fatal("cross-actor cursor accepted")
	}
	boom := errors.New("store")
	for _, stage := range []string{"page", "permission", "clock", "query"} {
		d := normalAdminDAO()
		in := ListAppsInput{}
		d.invitations = func(context.Context, string, store.Page) (store.GitHubAppInvitationPage, error) {
			return store.GitHubAppInvitationPage{}, boom
		}
		switch stage {
		case "page":
			in.Limit = 101
		case "permission":
			d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
				return githubpr.AdminMembership{}, boom
			}
		case "clock":
			d.clock = func(context.Context) (time.Time, error) { return time.Time{}, boom }
		}
		_, err := ListAdminInvitations(context.Background(), d, adminPrincipal, adminApp, in)
		if stage == "page" {
			faultCodeAdmin(t, err, "invalid_input")
		} else if !errors.Is(err, boom) {
			t.Fatal(stage, err)
		}
	}
}

func TestAdminInvitationRevocation(t *testing.T) {
	d := normalAdminDAO()
	revoked := false
	d.invitation = func(context.Context, string, string) (githubpr.AppInvitation, error) {
		i := normalInvitation()
		if revoked {
			i.RevokedAt = &adminNow
		}
		return i, nil
	}
	d.revoke = func(_ context.Context, a, i string, n time.Time) error {
		if a != adminApp || i != adminInvite || !n.Equal(adminNow) {
			t.Fatal("revoke identity")
		}
		revoked = true
		return nil
	}
	for _, changed := range []bool{true, false} {
		out, err := RevokeAdminInvitation(context.Background(), d, adminPrincipal, adminApp, adminInvite)
		if err != nil || out.Changed != changed || out.AppID != adminApp || out.InvitationID != adminInvite {
			t.Fatalf("%+v %v", out, err)
		}
	}
	boom := errors.New("store")
	for _, stage := range []string{"permission", "lookup", "clock", "write"} {
		d := normalAdminDAO()
		d.invitation = func(context.Context, string, string) (githubpr.AppInvitation, error) { return normalInvitation(), nil }
		d.revoke = func(context.Context, string, string, time.Time) error { return boom }
		switch stage {
		case "permission":
			d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
				return githubpr.AdminMembership{}, boom
			}
		case "lookup":
			d.invitation = func(context.Context, string, string) (githubpr.AppInvitation, error) {
				return githubpr.AppInvitation{}, boom
			}
		case "clock":
			d.clock = func(context.Context) (time.Time, error) { return time.Time{}, boom }
		}
		_, err := RevokeAdminInvitation(context.Background(), d, adminPrincipal, adminApp, adminInvite)
		if !errors.Is(err, boom) {
			t.Fatal(stage, err)
		}
	}
}
