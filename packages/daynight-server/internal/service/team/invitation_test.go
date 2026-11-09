package team

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"reflect"
	"testing"
)

func invitationInspectPlan(inspect bool) []string {
	p := []string{"validateInvitation", "snapshot", "reader", "invitation", "clock"}
	if inspect {
		p = append(p, "reader", "inspect")
	}
	return append(p, "snapshot_done")
}
func invitationAcceptPlan(refresh bool) []string {
	p := []string{"requireActor", "validateInvitation", "snapshot", "reader", "invitation", "clock", "reader", "snapshot_done", "write", "writer", "accept", "clock"}
	if refresh {
		p = append(p, "eligibility", "refresh")
	}
	return append(p, "write_done")
}
func fixtureAcceptance() core.TeamInvitationAcceptance {
	return core.TeamInvitationAcceptance{Team: fixtureTeam().TeamRef, Membership: fixtureMember().Membership, Joined: true, Consumed: true}
}

func TestTeamInvitationLifecycle(t *testing.T) {
	t.Run("mint", func(t *testing.T) {
		f := newTeamFixture(t, "validateInvitationWrite", "write", "writer", "mint", "clock", "write_done")
		invite := fixtureInvitation()
		invite.TokenHash = nil
		want := core.MintedTeamInvitation{Invitation: invite, Secret: f.secret}
		f.bindMint(want, nil, nil)
		got, err := f.service.CreateInvitation(f.ctx, f.p, f.rawID, f.expected)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("mint=%+v %v", got, err)
		}
	})
	t.Run("preview", func(t *testing.T) {
		f := newTeamFixture(t, invitationInspectPlan(true)...)
		want := core.TeamInvitationInspection{Team: fixtureTeam().TeamRef}
		f.bindInspection(fixtureInvitation(), want, nil)
		got, err := f.service.InspectInvitation(f.ctx, f.p, f.secret)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("preview=%+v %v", got, err)
		}
	})
	for _, existing := range []bool{false, true} {
		t.Run("accept", func(t *testing.T) {
			f := newTeamFixture(t, invitationAcceptPlan(true)...)
			want := fixtureAcceptance()
			if existing {
				want.Joined = false
				want.Consumed = false
				want.Membership = fixtureTeam().Membership
			}
			f.bindAccept(fixtureInvitation(), want, nil)
			f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, UserID: f.p.UserID}, nil)
			got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("accept=%+v %v", got, err)
			}
		})
	}
	t.Run("list", func(t *testing.T) {
		f := newTeamFixture(t, "validateRead", "snapshot", "reader", "listInvitations", "clock", "snapshot_done")
		invite := fixtureInvitation()
		invite.TokenHash = nil
		want := []model.TeamInvitation{invite}
		f.bindListInvitations(want, nil)
		got, err := f.service.ListInvitations(f.ctx, f.p, f.rawID)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("invitations=%+v %v", got, err)
		}
	})
	for _, changed := range []bool{false, true} {
		t.Run("revoke", func(t *testing.T) {
			f := newTeamFixture(t, "validateInvitationRevoke", "write", "writer", "revoke", "clock", "write_done")
			f.bindRevoke(changed, nil, nil)
			got, err := f.service.RevokeInvitation(f.ctx, f.p, f.rawID, f.inviteID, f.expected)
			if err != nil || got != changed {
				t.Fatalf("revoke=%v %v", got, err)
			}
		})
	}
	for _, code := range []string{"forbidden", "personal_team_immutable", "identity_mismatch"} {
		t.Run("mint "+code, func(t *testing.T) {
			preflight := code == "identity_mismatch"
			plan := []string{"validateInvitationWrite", "write", "writer", "mint", "clock", "write_done"}
			if preflight {
				plan = []string{"validateInvitationWrite"}
			}
			f := newTeamFixture(t, plan...)
			refusal := fixtureFault(code)
			if preflight {
				f.expected = teamFixtureTarget
				f.bindMint(core.MintedTeamInvitation{}, nil, refusal)
			} else {
				f.bindMint(core.MintedTeamInvitation{}, refusal, nil)
			}
			got, err := f.service.CreateInvitation(f.ctx, f.p, f.rawID, f.expected)
			if err != refusal || !reflect.DeepEqual(got, core.MintedTeamInvitation{}) {
				t.Fatalf("mint refusal=%+v %v", got, err)
			}
		})
	}
	t.Run("accept actor", func(t *testing.T) {
		f := newTeamFixture(t, "requireActor")
		f.expected = teamFixtureTarget
		refusal := fixtureFault("identity_mismatch")
		f.service.core.requireActor = func(p model.Principal, expected string) error {
			f.take("requireActor")
			f.samePrincipal(p)
			if expected != f.expected {
				t.Error("actor guard input changed")
			}
			return refusal
		}
		got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
		if err != refusal || !reflect.DeepEqual(got, core.TeamInvitationAcceptance{}) {
			t.Fatalf("actor refusal=%+v %v", got, err)
		}
	})
	for _, method := range []string{"list", "revoke"} {
		t.Run("personal "+method, func(t *testing.T) {
			refusal := fixtureFault("personal_team_immutable")
			if method == "list" {
				f := newTeamFixture(t, "validateRead", "snapshot", "reader", "listInvitations", "clock", "snapshot_done")
				f.bindListInvitations(nil, refusal)
				f.readCallbackError = refusal
				f.readError = refusal
				got, err := f.service.ListInvitations(f.ctx, f.p, f.rawID)
				if err != refusal || got != nil {
					t.Fatalf("personal list=%+v %v", got, err)
				}
			} else {
				f := newTeamFixture(t, "validateInvitationRevoke", "write", "writer", "revoke", "clock", "write_done")
				f.bindRevoke(false, refusal, nil)
				got, err := f.service.RevokeInvitation(f.ctx, f.p, f.rawID, f.inviteID, f.expected)
				if err != refusal || got {
					t.Fatalf("personal revoke=%v %v", got, err)
				}
			}
		})
	}
}

func TestTeamInvitationAcceptanceRetainsLowerFailures(t *testing.T) {
	for _, code := range []string{"invitation_unavailable", "internal_error"} {
		t.Run(code, func(t *testing.T) {
			f := newTeamFixture(t, invitationAcceptPlan(false)...)
			refusal := fixtureFault(code)
			f.bindAccept(fixtureInvitation(), core.TeamInvitationAcceptance{}, refusal)
			got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
			if err != refusal || !reflect.DeepEqual(got, core.TeamInvitationAcceptance{}) {
				t.Fatalf("accept refusal=%+v %v", got, err)
			}
		})
	}
	t.Run("consume failure", func(t *testing.T) {
		f := newTeamFixture(t, invitationAcceptPlan(false)...)
		cause := errors.New("declared consume failure")
		f.bindAccept(fixtureInvitation(), core.TeamInvitationAcceptance{}, cause)
		f.writeCallbackError = cause
		f.writeError = cause
		got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
		if err != cause || !reflect.DeepEqual(got, core.TeamInvitationAcceptance{}) {
			t.Fatalf("consume failure=%+v %v", got, err)
		}
	})
}
func TestTeamInvitationAcceptanceAndRevocationForwardOutcomes(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run("accept", func(t *testing.T) {
			f := newTeamFixture(t, invitationAcceptPlan(accepted)...)
			want := fixtureAcceptance()
			var refusal error
			if !accepted {
				want = core.TeamInvitationAcceptance{}
				refusal = fixtureFault("invitation_unavailable")
			}
			f.bindAccept(fixtureInvitation(), want, refusal)
			if accepted {
				f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, UserID: f.p.UserID}, nil)
			}
			got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
			if err != refusal || !reflect.DeepEqual(got, want) {
				t.Fatalf("accept outcome=%+v %v", got, err)
			}
		})
	}
	for _, changed := range []bool{false, true} {
		t.Run("revoke", func(t *testing.T) {
			f := newTeamFixture(t, "validateInvitationRevoke", "write", "writer", "revoke", "clock", "write_done")
			f.bindRevoke(changed, nil, nil)
			got, err := f.service.RevokeInvitation(f.ctx, f.p, f.rawID, f.inviteID, f.expected)
			if err != nil || got != changed {
				t.Fatalf("revoke outcome=%v %v", got, err)
			}
		})
	}
}
func TestTeamInvitationInspectIntegrityAndReadErrors(t *testing.T) {
	t.Run("existing member", func(t *testing.T) {
		f := newTeamFixture(t, invitationInspectPlan(true)...)
		want := core.TeamInvitationInspection{Team: fixtureTeam().TeamRef, Membership: fixturePointer(fixtureTeam().Membership)}
		f.bindInspection(fixtureInvitation(), want, nil)
		got, err := f.service.InspectInvitation(f.ctx, f.p, f.secret)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("member inspection=%+v %v", got, err)
		}
	})
	t.Run("member read failure", func(t *testing.T) {
		f := newTeamFixture(t, invitationInspectPlan(true)...)
		cause := errors.New("declared member read failure")
		f.bindInspection(fixtureInvitation(), core.TeamInvitationInspection{}, cause)
		f.readCallbackError = cause
		f.readError = cause
		got, err := f.service.InspectInvitation(f.ctx, f.p, f.secret)
		if err != cause || !reflect.DeepEqual(got, core.TeamInvitationInspection{}) {
			t.Fatalf("member read returned preview=%+v %v", got, err)
		}
	})
	for _, invalid := range []string{"orphan", "personal", "revoked", "expired", "consumed"} {
		t.Run(invalid, func(t *testing.T) {
			f := newTeamFixture(t, invitationInspectPlan(false)...)
			refusal := fixtureFault("invitation_unavailable")
			f.bindInvitation(fixtureInvitation(), refusal, nil)
			got, err := f.service.InspectInvitation(f.ctx, f.p, f.secret)
			if err != refusal || !reflect.DeepEqual(got, core.TeamInvitationInspection{}) {
				t.Fatalf("unavailable invitation=%+v %v", got, err)
			}
		})
	}
}
func TestTeamInvitationAcceptanceUsesCurrentWriteOutcome(t *testing.T) {
	for _, outcome := range []string{"revoked", "deleted"} {
		t.Run(outcome, func(t *testing.T) {
			f := newTeamFixture(t, invitationAcceptPlan(false)...)
			refusal := fixtureFault("invitation_unavailable")
			f.bindAccept(fixtureInvitation(), core.TeamInvitationAcceptance{}, refusal)
			got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
			if err != refusal || !reflect.DeepEqual(got, core.TeamInvitationAcceptance{}) {
				t.Fatalf("current invitation outcome=%+v %v", got, err)
			}
		})
	}
	t.Run("safe not-found completion", func(t *testing.T) {
		f := newTeamFixture(t, invitationAcceptPlan(false)...)
		cause := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
		f.bindAccept(fixtureInvitation(), core.TeamInvitationAcceptance{}, model.ErrNotFound)
		f.writeCallbackError = model.ErrNotFound
		f.completion.Outcome = store.TransactionNotCommitted
		f.writeError = cause
		got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
		teamFault(t, err, "invitation_unavailable")
		if !reflect.DeepEqual(got, core.TeamInvitationAcceptance{}) {
			t.Error("missing Team exposed acceptance")
		}
	})
	for _, cause := range []*store.TransactionError{
		{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: model.ErrNotFound},
		{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: model.ErrNotFound},
		{Phase: "commit", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: model.ErrNotFound},
	} {
		t.Run(string(cause.Outcome)+"/"+cause.Phase, func(t *testing.T) {
			f := newTeamFixture(t, invitationAcceptPlan(true)...)
			f.bindAccept(fixtureInvitation(), fixtureAcceptance(), nil)
			f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, UserID: f.p.UserID}, nil)
			f.writeError = cause
			f.completion.Outcome = cause.Outcome
			got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
			if err != cause || !reflect.DeepEqual(got, core.TeamInvitationAcceptance{}) {
				t.Fatalf("unsafe completion became ordinary unavailable=%+v %v", got, err)
			}
		})
	}
}
func TestTeamInvitationAcceptanceForwardsClockAndExpiryRefusal(t *testing.T) {
	f := newTeamFixture(t, invitationAcceptPlan(false)...)
	refusal := fixtureFault("invitation_unavailable")
	invite := fixtureInvitation()
	f.now = invite.ExpiresAt
	f.bindAccept(invite, core.TeamInvitationAcceptance{}, refusal)
	got, err := f.service.AcceptInvitation(f.ctx, f.p, f.secret, f.expected)
	if err != refusal || !reflect.DeepEqual(got, core.TeamInvitationAcceptance{}) {
		t.Fatalf("expiry refusal=%+v %v", got, err)
	}
}
