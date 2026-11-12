package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAccountWritesRejectWithoutCommitAndRequireConfirmedCompletion(t *testing.T) {
	for _, operation := range []string{"ensure", "patch"} {
		for _, stage := range []string{"success", "input", "write", "bootstrap", "user", "team", "capacity", "fresh", "unknown", "completion"} {
			if operation == "patch" && stage == "bootstrap" || operation == "ensure" && stage == "fresh" {
				continue
			}
			t.Run(operation+"/"+stage, func(t *testing.T) {
				f := newIdentityFixture(t)
				fault := &model.Fault{Code: "invalid_input", Cause: errors.New("original refusal")}
				failure := errors.New("commit error")
				input := model.User{UniAuthID: "external"}
				actual := model.User{ID: "actual-user", UniAuthID: "stored", PersonalTeam: model.TeamRef{Name: accountText("Personal")}}
				facts := store.PersonalTeamFacts{ID: "team", MemberCount: 1, OwnerAdminCount: 1}
				p := model.Principal{Kind: model.OAuthCredential, UserID: actual.ID, CredentialID: "real-credential"}
				patch := model.UserProfilePatch{Name: model.ProfileField{Present: true}}
				f.plan = []string{"validate"}
				f.identity.ops.validateExternalUser = func(got model.User) (model.User, error) {
					f.hit("validate")
					f.equal(got, input)
					if stage == "input" {
						return model.User{}, fault
					}
					return input, nil
				}
				f.identity.ops.validateProfilePatch = func(got model.UserProfilePatch) error {
					f.hit("validate")
					f.equal(got, patch)
					if stage == "input" {
						return fault
					}
					return nil
				}
				if stage != "input" {
					f.transaction()
					f.plan = append(f.plan, "write")
					steps := []string{"ensure", "bootstrap", "user", "team", "capacity"}
					if operation == "patch" {
						steps = []string{"lock", "patch", "user", "team", "capacity", "fresh"}
					}
					for _, step := range steps {
						f.plan = append(f.plan, step)
						if stage == step || stage == "write" && (step == "ensure" || step == "patch") {
							break
						}
					}
					f.plan = append(f.plan, "finish")
					if stage == "write" || stage == "bootstrap" || stage == "user" || stage == "team" || stage == "capacity" || stage == "fresh" {
						f.transactions[0].callbackErr = fault
						f.transactions[0].err = fault
					}
					if stage == "unknown" {
						f.transactions[0].completion.Outcome = store.TransactionUnknown
					}
					if stage == "completion" {
						f.transactions[0].err = failure
					}
				}
				f.identity.ops.ensureUser = func(ctx context.Context, dao store.IdentityDAO, u model.User, now time.Time) (model.User, bool, error) {
					f.hit("ensure")
					f.bound(ctx, dao)
					f.equal([]any{u, now}, []any{input, f.now})
					if stage == "write" {
						return model.User{}, false, fault
					}
					return actual, false, nil
				}
				f.identity.ops.bootstrapPersonalTeam = func(ctx context.Context, dao store.PersonalTeamDAO, id string, now time.Time) (model.TeamRef, error) {
					f.hit("bootstrap")
					if ctx != f.ctx || dao != f.scope.personal || id != actual.ID || now != f.now {
						t.Fatal("bootstrap capability changed")
					}
					if stage == "bootstrap" {
						return model.TeamRef{}, fault
					}
					return actual.PersonalTeam, nil
				}
				f.identity.ops.patchUser = func(ctx context.Context, dao store.IdentityDAO, id string, in model.UserProfilePatch) (model.User, error) {
					f.hit("patch")
					f.bound(ctx, dao)
					f.equal([]any{id, in}, []any{p.UserID, patch})
					if stage == "write" {
						return model.User{}, fault
					}
					return actual, nil
				}
				lockCalls := 0
				f.identity.ops.lockProfileCredential = func(ctx context.Context, dao store.IdentityDAO, family store.CredentialFamilyDAO, got model.Principal, resource string, now time.Time) error {
					name := "lock"
					if lockCalls > 0 {
						name = "fresh"
					}
					f.hit(name)
					f.bound(ctx, dao)
					if family != f.scope.family || got != p || resource != "https://daynight.example/api/v1" {
						t.Fatal("credential binding changed")
					}
					f.equal(now, f.now.Add(time.Duration(lockCalls)*time.Second))
					lockCalls++
					if name == "lock" {
						f.identity.now = func() time.Time { return f.now.Add(time.Second) }
					}
					if stage == "fresh" && name == "fresh" {
						return fault
					}
					return nil
				}
				f.identity.ops.user = func(ctx context.Context, dao store.IdentityDAO, got model.Principal) (model.User, store.PersonalTeamFacts, error) {
					f.hit("user")
					f.bound(ctx, dao)
					if got.UserID != actual.ID {
						t.Fatal("wrong user")
					}
					if stage == "user" {
						return model.User{}, facts, fault
					}
					return actual, facts, nil
				}
				f.identity.ops.validatePersonalTeam = func(got store.PersonalTeamFacts) error {
					f.hit("team")
					f.equal(got, facts)
					if stage == "team" {
						return fault
					}
					return nil
				}
				f.identity.ops.admitCompleteUser = func(got model.User, response bool) error {
					f.hit("capacity")
					want := actual
					want.PersonalTeam.ID = facts.ID
					want.PersonalTeam.Kind = "personal"
					f.equal(got, want)
					if !response {
						t.Fatal("response not admitted")
					}
					if stage == "capacity" {
						return fault
					}
					return nil
				}
				var got model.User
				var err error
				if operation == "ensure" {
					got, err = f.identity.EnsureUser(f.ctx, input)
				} else {
					got, err = f.identity.PatchUser(f.ctx, p, patch)
				}
				if stage == "success" {
					want := actual
					want.PersonalTeam.ID = facts.ID
					want.PersonalTeam.Kind = "personal"
					if err != nil || !reflect.DeepEqual(got, want) {
						t.Fatalf("result %#v %v", got, err)
					}
				} else {
					if err == nil || !reflect.DeepEqual(got, model.User{}) {
						t.Fatalf("failed result %#v %v", got, err)
					}
					if stage == "completion" && !errors.Is(err, failure) {
						t.Fatal(err)
					}
					if stage != "unknown" && stage != "completion" && !errors.Is(err, fault) {
						t.Fatal(err)
					}
				}
			})
		}
	}
}
func accountText(value string) *string { return &value }
