package identity

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestProfileAdmissionBeforePersistence(t *testing.T) {
	f := newIdentityFixture(t)
	first := completeIdentityLogin(t, f, "existing")
	ctx := context.Background()
	counts := func() [3]int {
		t.Helper()
		var result [3]int
		for i, table := range []string{"users", "teams", "sessions"} {
			if err := f.database.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&result[i]); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	for _, tc := range []struct {
		name, field string
		max         int
	}{
		{"id", "identityId", core.MaxProfileFieldBytes}, {"name", "name", core.MaxProfileFieldBytes},
		{"email", "email", core.MaxProfileFieldBytes}, {"avatar_url", "avatarUrl", core.MaxAvatarURLBytes},
	} {
		t.Run(tc.name, func(t *testing.T) {
			valid := identityProfile(first.User.UniAuthID)
			valid[tc.name] = strings.Repeat("a", tc.max)
			f.replies["valid-"+tc.name] = identityReply{status: http.StatusOK, body: valid}
			got := completeIdentityLogin(t, f, "valid-"+tc.name)
			if tc.name == "id" && got.User.UniAuthID != valid[tc.name] {
				t.Fatal("boundary identity changed")
			}
			if tc.name != "id" {
				var value *string
				switch tc.name {
				case "name":
					value = got.User.Name
				case "email":
					value = got.User.Email
				case "avatar_url":
					value = got.User.AvatarURL
				}
				if value == nil || *value != valid[tc.name] {
					t.Fatalf("boundary %s changed", tc.name)
				}
			}
			invalid := identityProfile(first.User.UniAuthID)
			invalid[tc.name] = strings.Repeat("a", tc.max+1)
			f.replies["invalid-"+tc.name] = identityReply{status: http.StatusOK, body: invalid}
			before := counts()
			old, err := f.identity.User(ctx, model.Principal{UserID: first.User.ID})
			if err != nil {
				t.Fatal(err)
			}
			start := startIdentityLogin(t, f, "/retry")
			result, err := f.identity.CompleteLogin(ctx, identityQuery(start, "invalid-"+tc.name), start.BrowserBinding)
			var failure *model.IdentityProviderError
			var violation *limit.Violation
			if !errors.As(err, &failure) || failure.Code != "identity_unavailable" || !errors.As(err, &violation) || violation.Field != tc.field || result.LoginID != start.ID || result.Secret != "" {
				t.Fatalf("rejection result=%+v err=%v", result, err)
			}
			after, err := f.identity.User(ctx, model.Principal{UserID: first.User.ID})
			if err != nil || !reflect.DeepEqual(old, after) || counts() != before {
				t.Fatalf("rejection changed stored state: %v", err)
			}
			calls := f.calls.Load()
			_, err = f.identity.CompleteLogin(ctx, identityQuery(start, "invalid-"+tc.name), start.BrowserBinding)
			requireFault(t, err, "unauthenticated")
			if f.calls.Load() != calls {
				t.Fatal("replayed consumed code")
			}
		})
	}
	profile := identityProfile(first.User.UniAuthID)
	profile["avatar_url"] = strings.Repeat("<", 180000)
	f.replies["expanded"] = identityReply{status: http.StatusOK, body: profile}
	before := counts()
	start := startIdentityLogin(t, f, "/")
	_, err := f.identity.CompleteLogin(ctx, identityQuery(start, "expanded"), start.BrowserBinding)
	var violation *limit.Violation
	var failure *model.IdentityProviderError
	if !errors.As(err, &failure) || !errors.As(err, &violation) || violation.Field != "profile" || counts() != before {
		t.Fatalf("expanded profile: %v", err)
	}

	avatar := "data:image/png;base64," + strings.Repeat("a", 240000)
	profile = identityProfile(first.User.UniAuthID)
	profile["avatar_url"], profile["name"], profile["email"], profile["email_verified"] = avatar, nil, nil, nil
	f.replies["data"] = identityReply{status: http.StatusOK, body: profile}
	got := completeIdentityLogin(t, f, "data")
	if got.User.AvatarURL == nil || *got.User.AvatarURL != avatar || got.User.Name != nil || got.User.Email != nil || got.User.EmailVerified != nil {
		t.Fatal("data URL or nullable fields changed")
	}
}
