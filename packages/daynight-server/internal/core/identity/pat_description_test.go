package identity

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type descriptionDAO struct {
	store.IdentityDAO
	calls           []string
	now, fresh      time.Time
	lockCount       int
	expire          bool
	changed, exists bool
	value, expected *string
	stored          model.PersonalAccessToken
	fail            string
	cause           error
}

func (d *descriptionDAO) LockSession(_ context.Context, _ model.Principal, now time.Time) error {
	d.calls = append(d.calls, "lock")
	d.lockCount++
	if d.fail == "first lock" && d.lockCount == 1 || d.fail == "final lock" && d.lockCount == 2 {
		return d.cause
	}
	if d.lockCount == 2 && (!now.Equal(d.fresh) || d.expire) {
		return model.ErrNotFound
	}
	return nil
}
func (d *descriptionDAO) CleanupCredentials(context.Context, time.Time) error {
	d.calls = append(d.calls, "cleanup")
	if d.fail == "cleanup" {
		return d.cause
	}
	return nil
}
func (d *descriptionDAO) InsertPAT(_ context.Context, token model.PersonalAccessToken) error {
	d.calls = append(d.calls, "insert")
	d.stored = token
	if d.fail == "insert" {
		return d.cause
	}
	return nil
}
func (d *descriptionDAO) FreshPATTime(context.Context, time.Time) (time.Time, error) {
	d.calls = append(d.calls, "fresh")
	if d.fail == "fresh" {
		return time.Time{}, d.cause
	}
	return d.fresh, nil
}
func (d *descriptionDAO) ListAllPATs(context.Context, string) ([]model.PersonalAccessToken, error) {
	d.calls = append(d.calls, "list")
	if d.fail == "list" {
		return nil, d.cause
	}
	return []model.PersonalAccessToken{{ID: "retained"}}, nil
}
func (d *descriptionDAO) ComparePATDescription(_ context.Context, _, _ string, expected, value *string) (bool, error) {
	d.calls = append(d.calls, "compare")
	d.expected = expected
	d.value = value
	return d.changed, nil
}
func (d *descriptionDAO) PATExists(context.Context, string, string) (bool, error) {
	d.calls = append(d.calls, "exists")
	return d.exists, nil
}

func TestPATDescriptionManagement(t *testing.T) {
	now := time.Now().UTC()
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	module := NewIdentity("")
	for _, tc := range []struct {
		name                    string
		changed, exists, expire bool
		want                    string
		calls                   []string
	}{
		{"update", true, false, false, "", []string{"lock", "compare", "fresh", "lock"}},
		{"conflict", false, true, false, "version_conflict", []string{"lock", "compare", "exists", "fresh", "lock"}},
		{"missing", false, false, false, "not_found", []string{"lock", "compare", "exists", "fresh", "lock"}},
		{"expired", true, false, true, "unauthenticated", []string{"lock", "compare", "fresh", "lock"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &descriptionDAO{now: now, fresh: now.Add(time.Minute), changed: tc.changed, exists: tc.exists, expire: tc.expire}
			raw := "  note  "
			gotID, got, err := module.UpdatePATDescription(t.Context(), d, d, p, id, p.UserID, nil, &raw, now)
			if tc.want != "" {
				checkFault(t, err, tc.want)
				if got != nil || gotID != "" {
					t.Fatal("returned refused receipt")
				}
			} else if err != nil || gotID != id || got == nil || *got != "note" || d.value == nil || *d.value != "note" {
				t.Fatalf("receipt %q %v %v", gotID, got, err)
			}
			if !reflect.DeepEqual(d.calls, tc.calls) {
				t.Fatalf("calls %v", d.calls)
			}
		})
	}
	bad := " leading"
	d := &descriptionDAO{fresh: now}
	_, _, err := module.UpdatePATDescription(t.Context(), d, d, p, id, p.UserID, &bad, nil, now)
	checkFault(t, err, "invalid_input")
	if len(d.calls) != 0 {
		t.Fatal(d.calls)
	}
	_, _, err = module.UpdatePATDescription(t.Context(), d, d, p, id, uuid.NewString(), nil, nil, now)
	checkFault(t, err, "forbidden")
}

func TestPATDescriptionCreateAndListRecheckSession(t *testing.T) {
	now := time.Now().UTC()
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	module := NewIdentity("")
	for _, expired := range []bool{false, true} {
		d := &descriptionDAO{fresh: now.Add(time.Minute), expire: expired}
		raw := " note "
		minted, err := module.CreatePATV2(t.Context(), d, d, p, p.UserID, CreatePAT{Name: "test"}, &raw, now)
		if expired {
			checkFault(t, err, "unauthenticated")
			if minted.Secret != "" {
				t.Fatal("secret escaped refusal")
			}
		} else if err != nil || minted.Secret == "" || d.stored.Description == nil || *d.stored.Description != "note" {
			t.Fatalf("mint result did not match the expected operation: %v", err)
		}
		if !reflect.DeepEqual(d.calls, []string{"lock", "cleanup", "insert", "fresh", "lock"}) {
			t.Fatal(d.calls)
		}
		d = &descriptionDAO{fresh: now.Add(time.Minute), expire: expired}
		items, err := module.ListPATsV2(t.Context(), d, d, p, now)
		if expired {
			checkFault(t, err, "unauthenticated")
			if items != nil {
				t.Fatal("released unauthorized list")
			}
		} else if err != nil || len(items) != 1 {
			t.Fatalf("list %v %v", items, err)
		}
	}
}

func TestPATOwnerRequiresSessionAndCanonicalMatchingAccount(t *testing.T) {
	user := "123e4567-e89b-12d3-a456-426614174000"
	p := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: uuid.NewString()}
	for _, tc := range []struct {
		name           string
		principal      model.Principal
		expected, code string
	}{
		{"non-session", model.Principal{Kind: model.PATCredential, UserID: user}, user, "forbidden"},
		{"malformed", p, "not-a-uuid", "invalid_input"},
		{"noncanonical", p, strings.ToUpper(user), "invalid_input"},
		{"different account", p, uuid.NewString(), "forbidden"},
		{"matching account", p, user, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePATOwner(tc.principal, tc.expected)
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				checkFault(t, err, tc.code)
			}
		})
	}
}

func TestPATCreateRejectsWithoutReturningCredential(t *testing.T) {
	now := time.Now().UTC()
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	cause := errors.New("storage failure")
	bad := "a\nb"
	for _, tc := range []struct {
		name        string
		principal   model.Principal
		expected    string
		input       CreatePAT
		description *string
		fail, code  string
		calls       []string
	}{
		{"wrong account", p, uuid.NewString(), CreatePAT{Name: "test"}, nil, "", "forbidden", nil},
		{"invalid description", p, p.UserID, CreatePAT{Name: "test"}, &bad, "", "invalid_input", nil},
		{"invalid name", p, p.UserID, CreatePAT{}, nil, "", "invalid_input", nil},
		{"initial session failure", p, p.UserID, CreatePAT{Name: "test"}, nil, "first lock", "", []string{"lock"}},
		{"cleanup failure", p, p.UserID, CreatePAT{Name: "test"}, nil, "cleanup", "", []string{"lock", "cleanup"}},
		{"insert failure", p, p.UserID, CreatePAT{Name: "test"}, nil, "insert", "", []string{"lock", "cleanup", "insert"}},
		{"fresh time failure", p, p.UserID, CreatePAT{Name: "test"}, nil, "fresh", "", []string{"lock", "cleanup", "insert", "fresh"}},
		{"final session failure", p, p.UserID, CreatePAT{Name: "test"}, nil, "final lock", "", []string{"lock", "cleanup", "insert", "fresh", "lock"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &descriptionDAO{fresh: now.Add(time.Minute), fail: tc.fail, cause: cause}
			result, err := NewIdentity("").CreatePATV2(t.Context(), d, d, tc.principal, tc.expected, tc.input, tc.description, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if !errors.Is(err, cause) {
				t.Fatalf("lost underlying failure: %v", err)
			}
			if !reflect.DeepEqual(result, MintedPAT{}) {
				t.Fatal("credential escaped rejected creation")
			}
			if !reflect.DeepEqual(d.calls, tc.calls) {
				t.Fatalf("calls %v, want %v", d.calls, tc.calls)
			}
		})
	}
}

func TestPATListRejectsWithoutReturningMetadata(t *testing.T) {
	now := time.Now().UTC()
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	cause := errors.New("storage failure")
	for _, tc := range []struct {
		name       string
		principal  model.Principal
		fail, code string
		calls      []string
	}{
		{"non-session", model.Principal{Kind: model.PATCredential}, "", "forbidden", nil},
		{"initial session failure", p, "first lock", "", []string{"lock"}},
		{"list failure", p, "list", "", []string{"lock", "list"}},
		{"fresh time failure", p, "fresh", "", []string{"lock", "list", "fresh"}},
		{"final session failure", p, "final lock", "", []string{"lock", "list", "fresh", "lock"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &descriptionDAO{fresh: now.Add(time.Minute), fail: tc.fail, cause: cause}
			result, err := NewIdentity("").ListPATsV2(t.Context(), d, d, tc.principal, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if !errors.Is(err, cause) {
				t.Fatalf("lost underlying failure: %v", err)
			}
			if result != nil {
				t.Fatal("metadata escaped refused read")
			}
			if !reflect.DeepEqual(d.calls, tc.calls) {
				t.Fatalf("calls %v, want %v", d.calls, tc.calls)
			}
		})
	}
}
