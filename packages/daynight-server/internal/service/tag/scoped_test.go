package tag

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func scopedAuthorization(t *testing.T, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	values, err := scopepolicy.Normalize(scopepolicy.PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, values, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedReadsAuthorizeBeforeCatalogAccess(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		run  func(*ScopedTags, model.CredentialAuthorization) (any, error)
		want []string
	}{
		{"get", func(s *ScopedTags, a model.CredentialAuthorization) (any, error) {
			return s.Get(ctx, a, projectID, tagIDValue)
		}, []string{"snapshot", "access", "tag", "usage"}},
		{"list", func(s *ScopedTags, a model.CredentialAuthorization) (any, error) {
			return s.List(ctx, a, projectID, ListInput{})
		}, []string{"snapshot", "access", "epoch", "tags", "usage"}},
		{"resolve", func(s *ScopedTags, a model.CredentialAuthorization) (any, error) {
			return s.Resolve(ctx, a, projectID, []string{tagIDValue})
		}, []string{"snapshot", "access", "resolve"}},
		{"colors", func(s *ScopedTags, a model.CredentialAuthorization) (any, error) {
			return s.ResolveColors(ctx, a, projectID, []string{tagIDValue}, nil)
		}, []string{"snapshot", "access", "epoch", "resolve"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &readFixture{epoch: "10000000-0000-4000-8000-000000000005", item: model.Tag{ID: tagIDValue}, page: store.TagPage{Items: []model.Tag{{ID: tagIDValue}}}, resolved: []model.Tag{{ID: tagIDValue, Name: "Alpha"}}}
			svc := NewScoped(f)
			for _, scopes := range [][]scopepolicy.ScopeID{{"tag:write"}, {"tag:delete"}, {"task:write"}} {
				f.calls = nil
				value, err := tc.run(svc, scopedAuthorization(t, scopes...))
				if faultCode(err) != "insufficient_scope" || !reflect.ValueOf(value).IsZero() || !reflect.DeepEqual(f.calls, []string{"snapshot", "access"}) {
					t.Fatalf("scopes=%v value=%+v calls=%v err=%v", scopes, value, f.calls, err)
				}
			}
			f.calls = nil
			if _, err := tc.run(svc, scopedAuthorization(t, "tag:read")); err != nil || !reflect.DeepEqual(f.calls, tc.want) {
				t.Fatalf("allowed calls=%v err=%v", f.calls, err)
			}
			f.calls, f.accessErr = nil, model.ErrNotFound
			value, err := tc.run(svc, scopedAuthorization(t, "tag:delete"))
			if faultCode(err) != "not_found" || !reflect.ValueOf(value).IsZero() || !reflect.DeepEqual(f.calls, []string{"snapshot", "access"}) {
				t.Fatalf("hidden value=%+v calls=%v err=%v", value, f.calls, err)
			}
		})
	}
}

func TestScopedWritesDenyWithoutCatalogOrAssociationEffects(t *testing.T) {
	ctx := context.Background()
	name, color := "Beta", "#ABCDEF"
	for _, tc := range []struct {
		name string
		run  func(*ScopedTags, model.CredentialAuthorization) (WriteResult, error)
	}{
		{"create", func(s *ScopedTags, a model.CredentialAuthorization) (WriteResult, error) {
			return s.Create(ctx, a, projectID, "Beta", nil)
		}},
		{"rename", func(s *ScopedTags, a model.CredentialAuthorization) (WriteResult, error) {
			return s.Rename(ctx, a, projectID, tagIDValue, 7, name)
		}},
		{"color", func(s *ScopedTags, a model.CredentialAuthorization) (WriteResult, error) {
			return s.Update(ctx, a, projectID, tagIDValue, 7, nil, &color)
		}},
		{"combined", func(s *ScopedTags, a model.CredentialAuthorization) (WriteResult, error) {
			return s.Update(ctx, a, projectID, tagIDValue, 7, &name, &color)
		}},
		{"unchanged", func(s *ScopedTags, a model.CredentialAuthorization) (WriteResult, error) {
			return s.Rename(ctx, a, projectID, tagIDValue, 7, "Alpha")
		}},
		{"delete", func(s *ScopedTags, a model.CredentialAuthorization) (WriteResult, error) {
			return s.Delete(ctx, a, projectID, tagIDValue, 7, true)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			denied := [][]scopepolicy.ScopeID{{"tag:read"}, {"task:write"}}
			if tc.name == "delete" {
				denied = append(denied, []scopepolicy.ScopeID{"tag:read", "tag:write"})
			} else {
				denied = append(denied, []scopepolicy.ScopeID{"tag:write"}, []scopepolicy.ScopeID{"tag:delete"})
			}
			for _, scopes := range denied {
				f := newFixture()
				before := f.item
				result, err := tc.run(NewScoped(f), scopedAuthorization(t, scopes...))
				if faultCode(err) != "insufficient_scope" || !errors.Is(err, scopepolicy.ErrInsufficientScope) || result.Outcome != store.TransactionNotCommitted || result.Item != (Item{}) || result.Deleted || f.item != before || !reflect.DeepEqual(f.calls, []string{"lock", "access"}) {
					t.Fatalf("scopes=%v result=%+v calls=%v err=%v", scopes, result, f.calls, err)
				}
			}
			for _, accessErr := range []error{model.ErrNotFound, &model.Fault{Code: "forbidden", Message: "Project access denied."}} {
				f := newFixture()
				f.accessErr = accessErr
				result, err := tc.run(NewScoped(f), scopedAuthorization(t, "tag:read", "tag:write", "tag:delete"))
				if !errors.Is(err, accessErr) || result.Outcome != store.TransactionNotCommitted || !reflect.DeepEqual(f.calls, []string{"lock", "access"}) {
					t.Fatalf("resource denial result=%+v calls=%v err=%v", result, f.calls, err)
				}
			}
		})
	}
}

func TestScopedAllowedWritesPreserveTransactionsAndMinimalDelete(t *testing.T) {
	ctx := context.Background()
	auth := scopedAuthorization(t, "tag:read", "tag:write")
	f := newFixture()
	result, err := NewScoped(f).Create(ctx, auth, projectID, "Beta", nil)
	if err != nil || result.Item.Tag.Name != "Beta" || result.Outcome != store.TransactionCommitted || !reflect.DeepEqual(f.calls, []string{"lock", "access", "time", "insert", "epoch"}) {
		t.Fatalf("create=%+v calls=%v err=%v", result, f.calls, err)
	}
	f = newFixture()
	color := "#ABCDEF"
	result, err = NewScoped(f).Update(ctx, auth, projectID, tagIDValue, 7, nil, &color)
	if err != nil || result.Item.Tag.Name != "Alpha" || result.Item.Tag.Color != color || result.Item.Usage.Tasks != 3 || result.Item.Tag.Version != 8 || result.Outcome != store.TransactionCommitted || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "usage", "time", "update", "touch", "epoch"}) {
		t.Fatalf("update=%+v calls=%v err=%v", result, f.calls, err)
	}
	f = newFixture()
	result, err = NewScoped(f).Rename(ctx, auth, projectID, tagIDValue, 7, "Alpha")
	if err != nil || result.Item.Tag.Version != 7 || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "usage"}) {
		t.Fatalf("no-op=%+v calls=%v err=%v", result, f.calls, err)
	}
	f = newFixture()
	result, err = NewScoped(f).Rename(ctx, auth, projectID, tagIDValue, 6, "Beta")
	if faultCode(err) != "version_conflict" || result.Outcome != store.TransactionNotCommitted || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag"}) {
		t.Fatalf("stale=%+v calls=%v err=%v", result, f.calls, err)
	}
	f = newFixture()
	result, err = NewScoped(f).Delete(ctx, scopedAuthorization(t, "tag:delete"), projectID, tagIDValue, 7, true)
	if err != nil || !result.Deleted || result.Item != (Item{}) || result.ProjectID != projectID || result.TagID != tagIDValue || result.Outcome != store.TransactionCommitted || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "time", "touch", "clear", "delete", "epoch"}) {
		t.Fatalf("delete=%+v calls=%v err=%v", result, f.calls, err)
	}
}

func TestScopedMissingPolicyDoesNotUseLegacyAdmission(t *testing.T) {
	ctx := context.Background()
	auth := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile}
	f := newFixture()
	result, err := NewScoped(f).Delete(ctx, auth, projectID, tagIDValue, 7, true)
	if err == nil || result.Outcome != store.TransactionNotCommitted || !reflect.DeepEqual(f.calls, []string{"lock", "access"}) {
		t.Fatalf("result=%+v calls=%v err=%v", result, f.calls, err)
	}
	r := &readFixture{}
	item, err := NewScoped(r).Get(ctx, auth, projectID, tagIDValue)
	if err == nil || item != (Item{}) || !reflect.DeepEqual(r.calls, []string{"snapshot", "access"}) {
		t.Fatalf("item=%+v calls=%v err=%v", item, r.calls, err)
	}
}
