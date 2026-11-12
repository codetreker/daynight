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

type directScope struct {
	store.TeamWriteScope
	identity    store.IdentityDAO
	family      store.CredentialFamilyDAO
	team        store.TeamWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s directScope) IdentityDAO() store.IdentityDAO                 { return s.identity }
func (s directScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.family }
func (s directScope) TeamDAO() store.TeamWriteDAO                    { return s.team }
func (s directScope) EligibilityDAO() store.WebhookEligibilityDAO    { return s.eligibility }

type directIdentityToken struct{ store.IdentityDAO }
type directFamilyToken struct{ store.CredentialFamilyDAO }
type directWriter struct {
	store.TeamWriter
	t           *testing.T
	ctx         context.Context
	scope       directScope
	calls       *[]string
	completions []store.Completion
	failures    []error
	callbacks   []error
}

func (w *directWriter) WriteTeam(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
	w.t.Helper()
	if ctx != w.ctx || id != teamFixtureID {
		w.t.Fatal("Team scope changed context or resource")
	}
	index := len(w.callbacks)
	*w.calls = append(*w.calls, "begin")
	err := op(w.scope)
	w.callbacks = append(w.callbacks, err)
	*w.calls = append(*w.calls, "complete")
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return w.completions[index], w.failures[index]
}

func TestDirectMembersThreePhaseCompletionAndFailures(t *testing.T) {
	cause := errors.New("declared operation failure")
	unknown := &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: cause}
	cases := []struct {
		name, fail string
		completion store.TransactionOutcome
		outcomeErr error
	}{
		{name: "success", completion: store.TransactionCommitted},
		{name: "same role", completion: store.TransactionCommitted},
		{name: "initial credential", fail: "credential1"},
		{name: "initial admin", fail: "authorize"},
		{name: "initial completion", fail: "complete1", completion: store.TransactionUnknown},
		{name: "initial unknown", fail: "complete1", outcomeErr: unknown},
		{name: "ensure", fail: "ensure"},
		{name: "final credential", fail: "credential2"},
		{name: "final member", fail: "add"},
		{name: "eligibility", fail: "eligibility"},
		{name: "fresh credential", fail: "credential3"},
		{name: "final completion", fail: "complete2", completion: store.TransactionNotCommitted},
		{name: "final unknown", fail: "complete2", outcomeErr: unknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.WithValue(t.Context(), struct{}{}, "identity")
			p := model.Principal{UserID: teamFixtureActor, CredentialID: teamFixtureInvitation, Kind: model.OAuthCredential}
			input := core.AddTeamMember{ExpectedUserID: p.UserID, User: model.User{UniAuthID: "target"}, Role: model.ProjectAdmin}
			user := model.User{ID: teamFixtureTarget, UniAuthID: "canonical-target", PersonalTeam: model.TeamRef{ID: teamFixtureInvitation, Kind: "personal"}}
			result := core.DirectMemberResult{Membership: fixtureMember().Membership, Added: tc.name != "same role"}
			result.Membership.Role = input.Role
			calls := []string{}
			sc := directScope{identity: &directIdentityToken{}, family: &directFamilyToken{}, team: &writerToken{}, eligibility: &eligibilityToken{}}
			writer := &directWriter{t: t, ctx: ctx, scope: sc, calls: &calls, completions: []store.Completion{{Outcome: store.TransactionCommitted}, {Outcome: store.TransactionCommitted}}, failures: make([]error, 2)}
			if tc.fail == "complete1" || tc.fail == "complete2" {
				index := 0
				if tc.fail == "complete2" {
					index = 1
				}
				writer.completions[index].Outcome = tc.completion
				writer.failures[index] = tc.outcomeErr
			}
			service := NewDirectMembers(writer, func(actual context.Context, actualUser model.User) (model.User, error) {
				calls = append(calls, "ensure")
				if actual != ctx || actualUser.UniAuthID != "canonical-target" {
					t.Fatal("EnsureUser input changed")
				}
				if len(writer.callbacks) != 1 || writer.callbacks[0] != nil {
					t.Fatal("EnsureUser preceded initial completion")
				}
				if tc.fail == "ensure" {
					return model.User{}, cause
				}
				return user, nil
			}, "https://example.test/api/v1")
			check := func(name string) error {
				calls = append(calls, name)
				if tc.fail == name {
					return cause
				}
				return nil
			}
			service.ops.validate = func(actual model.Principal, id, expected string, role model.ProjectRole) (string, error) {
				if actual != p || id != teamFixtureID || expected != p.UserID || role != input.Role {
					t.Fatal("validation input changed")
				}
				return teamFixtureID, check("validate")
			}
			service.ops.validateUser = func(actual model.User) (model.User, error) {
				if !reflect.DeepEqual(actual, input.User) {
					t.Fatal("external input changed")
				}
				return model.User{UniAuthID: "canonical-target"}, check("user")
			}
			tick := 0
			service.now = func() time.Time { tick++; return fixtureTeam().CreatedAt.Add(time.Duration(tick) * time.Second) }
			service.ops.credential = func(actual context.Context, id store.IdentityDAO, family store.CredentialFamilyDAO, actualP model.Principal, resource string, now time.Time) error {
				if actual != ctx || id != sc.identity || family != sc.family || actualP != p || resource != service.resource || now != fixtureTeam().CreatedAt.Add(time.Duration(tick)*time.Second) {
					t.Fatal("credential changed bound dependencies, actor, resource or fresh time")
				}
				return check("credential" + string(rune('0'+tick)))
			}
			service.ops.authorize = func(actual context.Context, dao store.TeamWriteDAO, actualP model.Principal) error {
				if actual != ctx || dao != sc.team || actualP != p {
					t.Fatal("initial authorization changed dependencies")
				}
				return check("authorize")
			}
			service.ops.add = func(actual context.Context, dao store.TeamWriteDAO, actualP model.Principal, target string, role model.ProjectRole) (core.DirectMemberResult, error) {
				if actual != ctx || dao != sc.team || actualP != p || target != user.ID || role != input.Role {
					t.Fatal("membership changed actor, target or bound DAO")
				}
				return result, check("add")
			}
			service.ops.eligibility = func(actual context.Context, dao store.WebhookEligibilityDAO, filter store.WebhookEligibilityFilter) error {
				if actual != ctx || dao != sc.eligibility || filter != (store.WebhookEligibilityFilter{TeamID: teamFixtureID, UserID: user.ID}) {
					t.Fatal("eligibility changed transaction, target or filter")
				}
				return check("eligibility")
			}
			got, err := service.AddMember(ctx, p, teamFixtureID, input)
			if tc.fail == "" {
				if err != nil || !reflect.DeepEqual(got, result) {
					t.Fatalf("result=%+v error=%v", got, err)
				}
				want := []string{"validate", "user", "begin", "credential1", "authorize", "complete", "ensure", "begin", "credential2", "add", "eligibility", "credential3", "complete"}
				if !reflect.DeepEqual(calls, want) {
					t.Fatalf("sequence=%v", calls)
				}
				return
			}
			if err == nil || !reflect.DeepEqual(got, core.DirectMemberResult{}) {
				t.Fatalf("failure exposed success: %+v %v", got, err)
			}
			if tc.outcomeErr != nil && !errors.Is(err, cause) {
				t.Fatal("lost transaction error chain")
			}
			if tc.fail != "complete1" && tc.fail != "complete2" && !errors.Is(err, cause) {
				t.Fatal("lost operation error chain")
			}
			expectedEnsure := tc.fail != "credential1" && tc.fail != "authorize" && tc.fail != "complete1"
			hasEnsure := false
			for _, c := range calls {
				hasEnsure = hasEnsure || c == "ensure"
			}
			if expectedEnsure != hasEnsure {
				t.Fatalf("EnsureUser calls after failure: %v", calls)
			}
			if len(writer.callbacks) == 2 && tc.fail != "complete2" && writer.callbacks[1] != cause {
				t.Fatal("final refusal did not roll back membership and eligibility")
			}
		})
	}
}

func TestDirectMembersValidationDoesNotOpenScope(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run("validation", func(t *testing.T) {
			cause := errors.New("invalid input")
			service := NewDirectMembers(nil, func(context.Context, model.User) (model.User, error) {
				t.Fatal("unexpected ensure")
				return model.User{}, nil
			}, "")
			service.ops.validate = func(model.Principal, string, string, model.ProjectRole) (string, error) {
				if !external {
					return "", cause
				}
				return teamFixtureID, nil
			}
			service.ops.validateUser = func(model.User) (model.User, error) { return model.User{}, cause }
			got, err := service.AddMember(t.Context(), model.Principal{}, teamFixtureID, core.AddTeamMember{})
			if err != cause || !reflect.DeepEqual(got, core.DirectMemberResult{}) {
				t.Fatalf("got=%+v error=%v", got, err)
			}
		})
	}
}
