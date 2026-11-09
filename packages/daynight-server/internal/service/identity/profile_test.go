package identity

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestSDKProfileFieldsReachAdmissionUnchanged(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		max         int
	}{
		{"id", "identityId", core.MaxProfileFieldBytes}, {"name", "name", core.MaxProfileFieldBytes}, {"email", "email", core.MaxProfileFieldBytes}, {"avatar_url", "avatarUrl", core.MaxAvatarURLBytes},
	} {
		for _, extra := range []int{0, 1} {
			t.Run(tc.name+"/"+string(rune('0'+extra)), func(t *testing.T) {
				f := newIdentityHTTPFixture(t)
				query := url.Values{"state": {secret.Random("")}, "code": {"profile"}}
				binding := secret.Random("")
				pending := model.LoginTransaction{ID: "consumed", ReturnPath: "/retry", Provider: "microsoft"}
				f.consume(query, binding, pending, nil)
				f.transaction()
				f.plan = []string{"validate-callback", "write", "consume", "finish", "provider", "profile"}
				value := strings.Repeat("a", tc.max+extra)
				profile := identityProfile("existing")
				profile[tc.name] = value
				f.replies["profile"] = identityReply{200, profile}
				f.identity.ops.validateProvider = func(string, string, error) error { f.hit("provider"); return nil }
				refusal := errors.New("profile admission refusal")
				f.identity.ops.admitProfileFields = func(got model.User) error {
					f.hit("profile")
					switch tc.name {
					case "id":
						f.equal(got.UniAuthID, value)
					case "name":
						f.equal(got.Name, &value)
					case "email":
						f.equal(got.Email, &value)
					case "avatar_url":
						f.equal(got.AvatarURL, &value)
					}
					if extra == 1 {
						return refusal
					}
					return nil
				}
				stop := errors.New("next phase marker")
				if extra == 0 {
					f.plan = append(f.plan, "new-session", "write")
					f.transaction()
					f.transactions[1].before = stop
					f.identity.ops.newSession = func(time.Time) (model.Session, string) { f.hit("new-session"); return model.Session{}, "opaque" }
				}
				got, err := f.identity.CompleteLogin(f.ctx, query, binding)
				f.equal(got, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath})
				if extra == 1 {
					var provider *model.IdentityProviderError
					if !errors.As(err, &provider) || provider.Code != "identity_unavailable" || !errors.Is(err, refusal) {
						t.Fatalf("profile admission=%v", err)
					}
				} else if !errors.Is(err, stop) {
					t.Fatalf("boundary never reached next phase: %v", err)
				}
			})
		}
	}
}
