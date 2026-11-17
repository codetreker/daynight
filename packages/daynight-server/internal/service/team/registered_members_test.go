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

func TestAddExistingMemberTransaction(t *testing.T) {
	cause := errors.New("operation failure")
	unknown := &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: cause}
	for _, fail := range []string{"", "validate", "credential1", "add", "eligibility", "credential2", "completion", "unknown"} {
		t.Run(fail, func(t *testing.T) {
			ctx := context.WithValue(t.Context(), struct{}{}, "request")
			p := model.Principal{UserID: teamFixtureActor, CredentialID: teamFixtureInvitation, Kind: model.OAuthCredential}
			calls := []string{}
			scope := directScope{identity: &directIdentityToken{}, family: &directFamilyToken{}, team: &writerToken{}, eligibility: &eligibilityToken{}}
			writer := &directWriter{t: t, ctx: ctx, scope: scope, calls: &calls, completions: []store.Completion{{Outcome: store.TransactionCommitted}}, failures: []error{nil}}
			if fail == "completion" {
				writer.completions[0].Outcome = store.TransactionNotCommitted
			}
			if fail == "unknown" {
				writer.completions[0].Outcome = store.TransactionUnknown
				writer.failures[0] = unknown
			}
			s := NewDirectMembers(writer, func(context.Context, model.User) (model.User, error) {
				t.Fatal("unexpected identity initialization")
				return model.User{}, nil
			}, "resource")
			check := func(name string) error {
				calls = append(calls, name)
				if fail == name {
					return cause
				}
				return nil
			}
			s.ops.validateExisting = func(actor model.Principal, id, expected, target string) (string, error) {
				if actor != p || id != teamFixtureID || expected != p.UserID || target != teamFixtureTarget {
					t.Fatal("validation input changed")
				}
				return id, check("validate")
			}
			tick := 0
			s.now = func() time.Time { tick++; return time.Unix(int64(tick), 0) }
			s.ops.credential = func(actual context.Context, identity store.IdentityDAO, family store.CredentialFamilyDAO, actor model.Principal, resource string, now time.Time) error {
				if actual != ctx || identity != scope.identity || family != scope.family || actor != p || resource != "resource" || now != time.Unix(int64(tick), 0).UTC() {
					t.Fatal("credential scope changed")
				}
				return check("credential" + string(rune('0'+tick)))
			}
			want := core.ExistingMemberResult{Membership: fixtureMember(), Added: true}
			s.ops.addExisting = func(actual context.Context, dao store.TeamWriteDAO, actor model.Principal, target string) (core.ExistingMemberResult, error) {
				if actual != ctx || dao != scope.team || actor != p || target != teamFixtureTarget {
					t.Fatal("member scope changed")
				}
				return want, check("add")
			}
			s.ops.eligibility = func(actual context.Context, dao store.WebhookEligibilityDAO, filter store.WebhookEligibilityFilter) error {
				if actual != ctx || dao != scope.eligibility || filter != (store.WebhookEligibilityFilter{TeamID: teamFixtureID, UserID: teamFixtureTarget}) {
					t.Fatal("eligibility scope changed")
				}
				return check("eligibility")
			}
			got, err := s.AddExistingMember(ctx, p, teamFixtureID, teamFixtureTarget, p.UserID)
			if fail == "" {
				if err != nil || !reflect.DeepEqual(got, want) {
					t.Fatalf("got=%+v err=%v", got, err)
				}
				if !reflect.DeepEqual(calls, []string{"validate", "begin", "credential1", "add", "eligibility", "credential2", "complete"}) {
					t.Fatalf("calls=%v", calls)
				}
			} else if err == nil || got != (core.ExistingMemberResult{}) || (fail != "completion" && !errors.Is(err, cause)) {
				t.Fatalf("failure exposed result or lost cause: %+v %v", got, err)
			}
		})
	}
}
