package github

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

const svcAdminApp = "00000000-0000-4000-8000-000000000011"
const svcAdminUser = "00000000-0000-4000-8000-000000000012"
const svcAdminInvite = "00000000-0000-4000-8000-000000000013"

type adminStoreTest struct {
	read  func(context.Context, func(store.GitHubAppAdminReader) error) error
	write func(context.Context, string, func(store.GitHubAppAdminWriter) error) (store.Completion, error)
}

func (s adminStoreTest) ReadGitHubAppAdmins(ctx context.Context, f func(store.GitHubAppAdminReader) error) error {
	return s.read(ctx, f)
}
func (s adminStoreTest) WriteGitHubAppAdmins(ctx context.Context, id string, f func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
	return s.write(ctx, id, f)
}

type adminServiceDAO struct {
	store.GitHubAppAdminWriter
	err error
}

func (d adminServiceDAO) App(context.Context, string) (githubpr.AppIdentity, error) {
	return githubpr.AppIdentity{ID: svcAdminApp}, d.err
}
func (d adminServiceDAO) Membership(_ context.Context, a, u string) (githubpr.AdminMembership, error) {
	return githubpr.AdminMembership{AppID: a, UserID: u, Version: 5}, d.err
}
func (d adminServiceDAO) ObservedAt(context.Context) (time.Time, error) {
	return time.Now().UTC(), d.err
}
func (d adminServiceDAO) InvitationByHash(context.Context, []byte) (githubpr.AppInvitation, error) {
	return githubpr.AppInvitation{ID: svcAdminInvite, AppID: svcAdminApp, CreatedBy: svcAdminUser, IssuerMembershipVersion: 5, ExpiresAt: time.Now().Add(time.Hour)}, d.err
}
func (d adminServiceDAO) Invitation(c context.Context, a, i string) (githubpr.AppInvitation, error) {
	return d.InvitationByHash(c, nil)
}
func (d adminServiceDAO) AdminPage(context.Context, string, store.Page) (store.GitHubAppAdminPage, error) {
	return store.GitHubAppAdminPage{}, d.err
}
func (d adminServiceDAO) InvitationPage(context.Context, string, store.Page) (store.GitHubAppInvitationPage, error) {
	return store.GitHubAppInvitationPage{}, d.err
}
func (d adminServiceDAO) CreateInvitation(context.Context, githubpr.AppInvitation, []byte) error {
	return d.err
}
func (d adminServiceDAO) RevokeInvitation(context.Context, string, string, time.Time) error {
	return d.err
}
func (d adminServiceDAO) CountAdmins(context.Context, string) (int64, error)       { return 2, d.err }
func (d adminServiceDAO) RemoveAdmin(context.Context, string, string, int64) error { return d.err }

func serviceAdminStore(t *testing.T, dao adminServiceDAO, reads, writes *int) adminStoreTest {
	t.Helper()
	check := func(ctx context.Context) {
		t.Helper()
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > core.OperationTimeout {
			t.Fatal("operation budget not applied")
		}
	}
	return adminStoreTest{
		read: func(ctx context.Context, f func(store.GitHubAppAdminReader) error) error {
			*reads++
			check(ctx)
			return f(dao)
		},
		write: func(ctx context.Context, id string, f func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
			*writes++
			check(ctx)
			if id != svcAdminApp {
				t.Fatal("wrong App root")
			}
			err := f(dao)
			return store.Completion{Outcome: store.TransactionCommitted}, err
		},
	}
}

func TestAdminManagerBindsScopesAndFiniteReceipts(t *testing.T) {
	reads, writes := 0, 0
	m := NewAdminManager(serviceAdminStore(t, adminServiceDAO{}, &reads, &writes))
	p := model.Principal{UserID: svcAdminUser, Kind: model.PATCredential, CredentialID: svcAdminUser}
	ctx := context.Background()
	token := secretutil.Random("dn_gai_")
	if _, err := m.ListAdmins(ctx, p, svcAdminApp, core.ListAppsInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ListAdminInvitations(ctx, p, svcAdminApp, core.ListAppsInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CreateAdminInvitation(ctx, p, svcAdminApp, svcAdminUser); err != nil {
		t.Fatal(err)
	}
	if _, err := m.RevokeAdminInvitation(ctx, p, svcAdminApp, svcAdminInvite, svcAdminUser); err != nil {
		t.Fatal(err)
	}
	if _, err := m.InspectAdminInvitation(ctx, p, token); err != nil {
		t.Fatal(err)
	}
	if _, err := m.AcceptAdminInvitation(ctx, p, token, svcAdminUser); err != nil {
		t.Fatal(err)
	}
	before := reads
	out, err := m.RemoveAdmin(ctx, p, svcAdminApp, svcAdminUser, core.RemoveAdminInput{ExpectedUserID: svcAdminUser, MembershipVersion: 5})
	if err != nil || !out.Removed || out.ActorIsAdmin || reads != before {
		t.Fatalf("self removal %+v %v reads=%d", out, err, reads)
	}
	if reads != 4 || writes != 4 {
		t.Fatalf("scopes %d reads %d writes", reads, writes)
	}
}

func TestAdminManagerRejectsInvalidWritesBeforeScope(t *testing.T) {
	m := NewAdminManager(adminStoreTest{})
	p := model.Principal{UserID: svcAdminUser, Kind: model.PATCredential, CredentialID: svcAdminUser}
	ctx := context.Background()
	token := secretutil.Random("dn_gai_")
	cases := []func() error{
		func() error { _, e := m.InspectAdminInvitation(ctx, model.Principal{}, token); return e },
		func() error { _, e := m.AcceptAdminInvitation(ctx, model.Principal{}, token, svcAdminUser); return e },
		func() error { _, e := m.CreateAdminInvitation(ctx, p, svcAdminApp, "bad"); return e },
		func() error { _, e := m.RevokeAdminInvitation(ctx, p, svcAdminApp, svcAdminInvite, "bad"); return e },
		func() error { _, e := m.RevokeAdminInvitation(ctx, p, svcAdminApp, "bad", svcAdminUser); return e },
		func() error {
			_, e := m.RemoveAdmin(ctx, p, svcAdminApp, svcAdminUser, core.RemoveAdminInput{})
			return e
		},
		func() error {
			_, e := m.RemoveAdmin(ctx, p, svcAdminApp, "bad", core.RemoveAdminInput{ExpectedUserID: svcAdminUser, MembershipVersion: 5})
			return e
		},
		func() error {
			_, e := m.RemoveAdmin(ctx, p, svcAdminApp, svcAdminUser, core.RemoveAdminInput{ExpectedUserID: svcAdminUser})
			return e
		},
		func() error { _, e := m.InspectAdminInvitation(ctx, p, "bad"); return e },
		func() error { _, e := m.AcceptAdminInvitation(ctx, p, token, "bad"); return e },
		func() error { _, e := m.AcceptAdminInvitation(ctx, p, "bad", svcAdminUser); return e },
	}
	for i, f := range cases {
		if err := f(); err == nil {
			t.Fatalf("case %d accepted", i)
		}
	}
}

func TestAdminManagerPassesParentCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := adminStoreTest{read: func(got context.Context, _ func(store.GitHubAppAdminReader) error) error {
		if !errors.Is(got.Err(), context.Canceled) {
			t.Fatal("parent cancellation lost")
		}
		return got.Err()
	}}
	_, err := NewAdminManager(s).InspectAdminInvitation(ctx, model.Principal{UserID: svcAdminUser, Kind: model.PATCredential, CredentialID: svcAdminUser}, secretutil.Random("dn_gai_"))
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestAdminTransactionCompletionPrecedence(t *testing.T) {
	boom := errors.New("completion failed")
	refusal := &model.Fault{Code: "last_admin", Message: "last"}
	for _, tc := range []struct {
		name                   string
		outcome                store.TransactionOutcome
		callbackErr, finishErr error
		wantCode               string
		wantCause              error
	}{
		{"committed", store.TransactionCommitted, nil, nil, "", nil},
		{"unknown", store.TransactionUnknown, nil, boom, "github_write_outcome_unknown", boom},
		{"unknown_over_refusal", store.TransactionUnknown, refusal, boom, "github_write_outcome_unknown", boom},
		{"refusal", store.TransactionCommitted, refusal, nil, "last_admin", refusal},
		{"failure", store.TransactionNotCommitted, nil, boom, "", boom},
		{"not_found", store.TransactionNotCommitted, nil, model.ErrNotFound, "not_found", model.ErrNotFound},
		{"uncommitted", store.TransactionNotCommitted, nil, nil, "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := adminStoreTest{write: func(_ context.Context, _ string, f func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
				calls++
				if err := f(nil); err != nil {
					t.Fatal(err)
				}
				return store.Completion{Outcome: tc.outcome}, tc.finishErr
			}}
			out, err := adminWrite(context.Background(), s, svcAdminApp, func(context.Context, store.GitHubAppAdminWriter) (string, error) {
				return "one-time secret", tc.callbackErr
			})
			if calls != 1 {
				t.Fatal(calls)
			}
			if tc.name == "committed" {
				if err != nil || out != "one-time secret" {
					t.Fatal(out, err)
				}
				return
			}
			if err == nil || out != "" {
				t.Fatalf("leaked result %q %v", out, err)
			}
			if tc.wantCause != nil && !errors.Is(err, tc.wantCause) {
				t.Fatalf("lost cause %v", err)
			}
			if tc.wantCode != "" {
				var fault *model.Fault
				var management *ManagementError
				code := ""
				if errors.As(err, &fault) {
					code = fault.Code
				}
				if errors.As(err, &management) {
					code = management.Code
				}
				if code != tc.wantCode {
					t.Fatalf("code=%s want=%s", code, tc.wantCode)
				}
			}
		})
	}
	for _, finishErr := range []error{nil, boom} {
		s := adminStoreTest{read: func(_ context.Context, f func(store.GitHubAppAdminReader) error) error {
			if err := f(nil); err != nil {
				t.Fatal(err)
			}
			return finishErr
		}}
		out, err := adminRead(context.Background(), s, func(context.Context, store.GitHubAppAdminReader) (string, error) { return "partial", refusal })
		if out != "" || err == nil {
			t.Fatal(out, err)
		}
		if finishErr != nil && !errors.Is(err, boom) {
			t.Fatal(err)
		}
	}
}

func TestAdminAcceptanceLookupAndRootRecheckErrors(t *testing.T) {
	ctx := context.Background()
	p := model.Principal{UserID: svcAdminUser, Kind: model.PATCredential, CredentialID: svcAdminUser}
	token := secretutil.Random("dn_gai_")
	for _, stage := range []string{"lookup_missing", "lookup_error", "root_missing", "unknown"} {
		t.Run(stage, func(t *testing.T) {
			reads, writes := 0, 0
			dao := adminServiceDAO{}
			if stage == "lookup_missing" {
				dao.err = model.ErrNotFound
			}
			if stage == "lookup_error" {
				dao.err = context.Canceled
			}
			s := serviceAdminStore(t, dao, &reads, &writes)
			if stage == "root_missing" {
				s.write = func(context.Context, string, func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
					writes++
					return store.Completion{Outcome: store.TransactionNotCommitted}, model.ErrNotFound
				}
			}
			if stage == "unknown" {
				s.write = func(context.Context, string, func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
					writes++
					return store.Completion{Outcome: store.TransactionUnknown}, context.DeadlineExceeded
				}
			}
			_, err := NewAdminManager(s).AcceptAdminInvitation(ctx, p, token, svcAdminUser)
			if err == nil || reads != 1 || writes > 1 {
				t.Fatal(err, reads, writes)
			}
			if stage == "lookup_missing" || stage == "root_missing" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "invitation_unavailable" {
					t.Fatal(err)
				}
			}
			if stage == "lookup_error" && !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
		})
	}
}
