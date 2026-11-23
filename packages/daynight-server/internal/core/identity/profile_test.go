package identity

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func profileText(value string) *string { return &value }
func TestExternalUserAndPatchAdmission(t *testing.T) {
	for _, id := range []string{"opaque", "microsoft:tenant:object", "msft:object@tenant"} {
		u, err := ValidateExternalUser(model.User{UniAuthID: id, Name: profileText(" Display ")})
		if err != nil || u.Name == nil || *u.Name != " Display " {
			t.Fatalf("valid input lost: %#v %v", u, err)
		}
		if id != "opaque" && u.UniAuthID != "msft:object@tenant" {
			t.Fatal(u.UniAuthID)
		}
	}
	for _, id := range []string{"", "\xff", "bad\x00id", "bad\nid", strings.Repeat("a", MaxProfileFieldBytes+1), "microsoft:bad", "msft:bad"} {
		if _, err := ValidateExternalUser(model.User{UniAuthID: id}); err == nil {
			t.Fatalf("accepted ID %q", id)
		}
	}
	for _, u := range []model.User{{UniAuthID: "x", Email: profileText("mail")}, {UniAuthID: "x", EmailVerified: new(bool)}, {UniAuthID: "x", Name: profileText("\x00")}, {UniAuthID: "x", AvatarURL: profileText("\xff")}} {
		if _, err := ValidateExternalUser(u); err == nil {
			t.Fatalf("accepted user %#v", u)
		}
	}
	for _, patch := range []model.UserProfilePatch{{}, {Name: model.ProfileField{Value: profileText("omitted")}}, {Name: model.ProfileField{Present: true, Value: profileText("\xff")}}, {Name: model.ProfileField{Present: true, Value: profileText("a\x00b")}}, {Name: model.ProfileField{Present: true, Value: profileText(strings.Repeat("a", MaxProfileFieldBytes+1))}}, {AvatarURL: model.ProfileField{Present: true, Value: profileText(strings.Repeat("a", MaxAvatarURLBytes+1))}}} {
		if err := ValidateProfilePatch(patch); err == nil {
			t.Fatalf("accepted patch %#v", patch)
		}
	}
	for _, patch := range []model.UserProfilePatch{{Name: model.ProfileField{Present: true}}, {Name: model.ProfileField{Present: true, Value: profileText("")}}, {AvatarURL: model.ProfileField{Present: true, Value: profileText(strings.Repeat("a", MaxAvatarURLBytes))}}} {
		if err := ValidateProfilePatch(patch); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ValidateExternalUser(model.User{UniAuthID: "x", AvatarURL: profileText(strings.Repeat("<", MaxAvatarURLBytes))}); err == nil {
		t.Fatal("encoded profile overflow accepted")
	}
	if err := AdmitCompleteUser(model.User{UniAuthID: "x", PersonalTeam: model.TeamRef{Name: profileText(strings.Repeat("x", MaxIdentityResponseBytes))}}, true); err == nil {
		t.Fatal("complete response overflow accepted")
	}
}

type profileDAO struct {
	store.IdentityDAO
	t         *testing.T
	input     model.User
	patch     model.UserProfilePatch
	actual    model.User
	inserted  bool
	err       error
	now       time.Time
	principal model.Principal
	calls     int
}

func (d *profileDAO) EnsureUser(ctx context.Context, u model.User, now time.Time) (model.User, bool, error) {
	d.calls++
	if ctx != d.t.Context() || now != d.now || u.UniAuthID != d.input.UniAuthID || !reflect.DeepEqual(u.Name, d.input.Name) {
		d.t.Fatalf("ensure input %#v %v", u, now)
	}
	if _, err := uuid.Parse(u.ID); err != nil {
		d.t.Fatal(err)
	}
	return d.actual, d.inserted, d.err
}
func (d *profileDAO) PatchUser(ctx context.Context, id string, p model.UserProfilePatch) (model.User, error) {
	d.calls++
	if ctx != d.t.Context() || id != d.principal.UserID || !reflect.DeepEqual(p, d.patch) {
		d.t.Fatal("patch input changed")
	}
	return d.actual, d.err
}
func (d *profileDAO) LockProfileCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.calls++
	if ctx != d.t.Context() || p != d.principal || now != d.now {
		d.t.Fatal("native profile credential binding lost")
	}
	return d.err
}

type profileFamily struct {
	store.CredentialFamilyDAO
	d *profileDAO
}

func (f profileFamily) LockAccess(ctx context.Context, p model.Principal, b []store.OAuthBinding, now time.Time) error {
	d := f.d
	d.calls++
	if ctx != d.t.Context() || p != d.principal || now != d.now || !reflect.DeepEqual(b, []store.OAuthBinding{{Resource: "https://example.test/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID}}) {
		d.t.Fatalf("API binding changed %#v", b)
	}
	return d.err
}
func TestProfileOperationsDelegateExactInputsAndPreserveFailures(t *testing.T) {
	module := NewIdentity("")
	failure := errors.New("database failure")
	for _, err := range []error{nil, failure, model.ErrNotFound} {
		d := &profileDAO{t: t, now: time.Now(), input: model.User{UniAuthID: "msft:object@tenant", Name: profileText("name")}, actual: model.User{ID: "actual", UniAuthID: "stored", Name: profileText("unchanged")}, inserted: true, err: err, principal: model.Principal{UserID: "owner", CredentialID: "credential"}, patch: model.UserProfilePatch{Name: model.ProfileField{Present: true}}}
		got, inserted, gotErr := module.EnsureUser(t.Context(), d, d.input, d.now)
		if !reflect.DeepEqual(got, d.actual) || !inserted || gotErr != err {
			t.Fatal(got, inserted, gotErr)
		}
		got, gotErr = module.PatchUser(t.Context(), d, d.principal.UserID, d.patch)
		if !reflect.DeepEqual(got, d.actual) || gotErr != err {
			t.Fatal(got, gotErr)
		}
		for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential, model.OAuthCredential} {
			d.principal.Kind = kind
			gotErr = module.LockProfileCredential(t.Context(), d, profileFamily{d: d}, d.principal, "https://example.test/api/v1", d.now)
			if err == model.ErrNotFound {
				checkFault(t, gotErr, "unauthenticated")
			} else if gotErr != err {
				t.Fatal(gotErr)
			}
		}
		calls := d.calls
		if _, _, err := module.EnsureUser(t.Context(), d, model.User{}, d.now); err == nil {
			t.Fatal("invalid ensure accepted")
		}
		if _, err := module.PatchUser(t.Context(), d, "owner", model.UserProfilePatch{}); err == nil {
			t.Fatal("empty patch accepted")
		}
		for _, resource := range []string{"%", "https://example.test/mcp", "https://example.test/api/v1?x=y", "https://user@example.test/api/v1", "https://example.test/api/v1#x"} {
			checkFault(t, module.LockProfileCredential(t.Context(), d, profileFamily{d: d}, d.principal, resource, d.now), "unauthenticated")
		}
		d.principal.Kind = "unsupported"
		checkFault(t, module.LockProfileCredential(t.Context(), d, profileFamily{d: d}, d.principal, "", d.now), "unauthenticated")
		if d.calls != calls {
			t.Fatal("invalid input reached DAO")
		}
	}
}
