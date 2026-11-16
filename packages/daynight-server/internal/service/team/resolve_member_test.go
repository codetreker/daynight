package team

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type resolveServiceDAO struct {
	store.TeamWriteDAO
	calls     *[]string
	member    model.TeamMember
	lookupErr error
}

func (d resolveServiceDAO) Team(ctx context.Context, actor string) (model.Team, error) {
	*d.calls = append(*d.calls, "authorize")
	return fixtureTeam(), nil
}
func (d resolveServiceDAO) MemberByExternalID(ctx context.Context, external string) (model.TeamMember, error) {
	*d.calls = append(*d.calls, "lookup")
	if external != "target" {
		panic("unexpected external identity")
	}
	return d.member, d.lookupErr
}

func TestResolveMemberTransactionCompletion(t *testing.T) {
	cause := errors.New("failure")
	for _, tc := range []struct {
		name              string
		lookupErr         error
		credentialFailure int
		completion        store.TransactionOutcome
		completionErr     error
	}{
		{name: "member", completion: store.TransactionCommitted},
		{name: "absent", lookupErr: model.ErrNotFound, completion: store.TransactionCommitted},
		{name: "lookup failure", lookupErr: cause, completion: store.TransactionCommitted},
		{name: "initial credential", credentialFailure: 1, completion: store.TransactionCommitted},
		{name: "fresh credential", credentialFailure: 2, completion: store.TransactionCommitted},
		{name: "unconfirmed completion", completion: store.TransactionUnknown},
		{name: "completion error", completion: store.TransactionUnknown, completionErr: cause},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			p := model.Principal{UserID: teamFixtureActor, CredentialID: teamFixtureInvitation, Kind: model.OAuthCredential}
			calls := []string{}
			member := fixtureMember().Membership
			dao := resolveServiceDAO{calls: &calls, member: member, lookupErr: tc.lookupErr}
			sc := directScope{team: dao, identity: &directIdentityToken{}, family: &directFamilyToken{}}
			writer := &directWriter{t: t, ctx: ctx, scope: sc, calls: &calls, completions: []store.Completion{{Outcome: tc.completion}}, failures: []error{tc.completionErr}}
			service := NewDirectMembers(writer, func(context.Context, model.User) (model.User, error) {
				t.Fatal("unexpected user initialization")
				return model.User{}, nil
			}, "resource")
			count := 0
			service.ops.credential = func(actual context.Context, id store.IdentityDAO, family store.CredentialFamilyDAO, actor model.Principal, resource string, now time.Time) error {
				count++
				calls = append(calls, "credential")
				if actual != ctx || id != sc.identity || family != sc.family || actor != p || resource != "resource" {
					t.Fatal("credential scope changed")
				}
				if count == tc.credentialFailure {
					return cause
				}
				return nil
			}
			got, err := service.ResolveMember(ctx, p, teamFixtureID, core.ResolveTeamMember{ExpectedUserID: p.UserID, ExternalUserID: "target"})
			if tc.name == "member" || tc.name == "absent" {
				if err != nil || (tc.name == "member" && (got == nil || *got != member)) || (tc.name == "absent" && got != nil) {
					t.Fatalf("result=%+v error=%v", got, err)
				}
				if !reflect.DeepEqual(calls, []string{"begin", "credential", "authorize", "lookup", "credential", "complete"}) {
					t.Fatalf("sequence=%v", calls)
				}
			} else if err == nil || got != nil {
				t.Fatalf("failure exposed result=%+v error=%v", got, err)
			}
		})
	}
}
