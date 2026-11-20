package mcp

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
)

type combinedTagFixture struct {
	ScopedTagOperations
	t     *testing.T
	calls int
}

func (s *combinedTagFixture) List(ctx context.Context, a model.CredentialAuthorization, project string, _ tagservice.ListInput) (tagservice.Page, error) {
	s.t.Helper()
	if ctx.Err() != nil || project != testProjectID || a.Principal.UserID != testUserID {
		s.t.Fatalf("unexpected context, project or principal: %+v %q %v", a.Principal, project, ctx.Err())
	}
	s.calls++
	if err := scopeadmission.Require(a, scopepolicy.TagRead); err != nil {
		return tagservice.Page{}, err
	}
	return tagservice.Page{Items: []tagservice.Item{tagTestItem("combined")}}, nil
}

func (s *combinedTagFixture) Create(_ context.Context, a model.CredentialAuthorization, project, name string, _ *string) (tagservice.WriteResult, error) {
	s.calls++
	if err := scopeadmission.Require(a, scopepolicy.TagWrite); err != nil {
		return tagservice.WriteResult{Outcome: store.TransactionNotCommitted}, err
	}
	return tagTestWrite(tagTestItem(name)), nil
}

func TestScopedTagAndProjectToolsShareAuthentication(t *testing.T) {
	for _, order := range []string{"tag first", "authentication first"} {
		t.Run(order, func(t *testing.T) {
			f := newEntryFixture(t)
			auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{
				"all":     scopedTestAuthorization(t, "project:read", "tag:read"),
				"project": scopedTestAuthorization(t, "project:read"),
				"tag":     scopedTestAuthorization(t, "tag:read"),
			}}
			tags := &combinedTagFixture{t: t}
			projects := &scopedProjectFixture{visible: true}
			resolverCalls := 0
			resolver := func(ctx context.Context, actor RequestActor) (model.CredentialAuthorization, error) {
				resolverCalls++
				current, err := TagAuthorizationFromActor(ctx, actor)
				if err != nil {
					return current, err
				}
				// Independently constructed but equal snapshots must be accepted.
				copyPolicy, err := scopepolicy.NewPolicy(current.Policy.Kind(), current.Policy.Scopes(), current.Policy.Version())
				if err != nil {
					return current, err
				}
				current.Policy = &copyPolicy
				return current, nil
			}
			if order == "tag first" {
				if err := RegisterScopedTagTools(f.entry, tags, resolver); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.entry.EnableScopedAuthentication(auth); err != nil {
				t.Fatal(err)
			}
			if order == "authentication first" {
				if err := RegisterScopedTagTools(f.entry, tags, resolver); err != nil {
					t.Fatal(err)
				}
			}
			if err := RegisterScopedProjectTools(f.entry, projects, &identityservice.Identity{}, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			if err := RegisterTagTools(f.entry, tagTestOperations{t: t}); err == nil {
				t.Fatal("legacy registration replaced scoped tags")
			}
			client := func(token string) *structClient { return &structClient{t: t, client: f.client(t, "2026-07-28", token)} }
			all, project, tag := client("all"), client("project"), client("tag")
			v := all.call("tag_list", map[string]any{"projectId": testProjectID}, false)
			items := object(t, v["data"])["items"].([]any)
			if len(items) != 1 || object(t, items[0])["name"] != "combined" {
				t.Fatalf("tag result: %#v", v)
			}
			all.call("project_list", map[string]any{}, false)
			v = project.call("tag_list", map[string]any{"projectId": testProjectID}, true)
			if object(t, v["error"])["code"] != "insufficient_scope" || v["data"] != nil {
				t.Fatalf("tag refusal: %#v", v)
			}
			v = tag.call("project_list", map[string]any{}, true)
			if object(t, v["error"])["code"] != "insufficient_scope" || v["data"] != nil {
				t.Fatalf("project refusal: %#v", v)
			}
			if resolverCalls != 2 || tags.calls != 2 {
				t.Fatalf("tag resolver calls=%d, operations=%d", resolverCalls, tags.calls)
			}
		})
	}
}

func TestScopedMCPKeepsLegacyTagToolsClosed(t *testing.T) {
	f := newEntryFixture(t)
	legacyCalls := 0
	legacy := tagTestOperations{t: t, list: func(context.Context, model.Principal, string, tagservice.ListInput) (tagservice.Page, error) {
		legacyCalls++
		return tagservice.Page{}, nil
	}}
	if err := RegisterTagTools(f.entry, legacy); err != nil {
		t.Fatal(err)
	}
	a := scopedTestAuthorization(t, "project:read", "tag:read")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"all": a}}); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedTagTools(f.entry, &combinedTagFixture{t: t}, TagAuthorizationFromActor); err == nil {
		t.Fatal("scoped registration replaced legacy tags")
	}
	if err := RegisterScopedProjectTools(f.entry, &scopedProjectFixture{visible: true}, &identityservice.Identity{}, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "all")}
	v := c.call("tag_list", map[string]any{"projectId": testProjectID}, true)
	if object(t, v["error"])["code"] != "forbidden" || legacyCalls != 0 {
		t.Fatalf("legacy tag invoked: %#v, calls=%d", v, legacyCalls)
	}
	c.call("project_list", map[string]any{}, false)
}

func TestScopedTagResolverCannotBroadenRequestSnapshot(t *testing.T) {
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "project:read")
	broader := scopedTestAuthorization(t, "project:read", "tag:read")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"project": a}}); err != nil {
		t.Fatal(err)
	}
	tags := &combinedTagFixture{t: t}
	resolverCalls := 0
	resolver := func(context.Context, RequestActor) (model.CredentialAuthorization, error) {
		resolverCalls++
		return broader, nil
	}
	if err := RegisterScopedTagTools(f.entry, tags, resolver); err != nil {
		t.Fatal(err)
	}
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "project")}
	v := c.call("tag_list", map[string]any{"projectId": testProjectID}, true)
	if object(t, v["error"])["code"] != "internal_error" || v["data"] != nil || resolverCalls != 1 || tags.calls != 0 {
		t.Fatalf("mismatched policy exposed data: %#v", v)
	}
}

func TestScopedTagResolverRejectsChangedVersionBeforeWrite(t *testing.T) {
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "project:read")
	other := a
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, a.Policy.Scopes(), a.Policy.Version()+1)
	if err != nil {
		t.Fatal(err)
	}
	other.Policy = &policy
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"project": a}}); err != nil {
		t.Fatal(err)
	}
	tags := &combinedTagFixture{t: t}
	if err := RegisterScopedTagTools(f.entry, tags, func(context.Context, RequestActor) (model.CredentialAuthorization, error) { return other, nil }); err != nil {
		t.Fatal(err)
	}
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "project")}
	v := c.call("tag_create", map[string]any{"projectId": testProjectID, "name": "unallowed"}, true)
	if e := object(t, v["error"]); e["code"] != "internal_error" || e["writeOutcome"] != "not_committed" || tags.calls != 0 {
		t.Fatalf("mismatched policy wrote data: %#v", v)
	}
}

func TestTagAuthorizationFromActorRejectsMissingOrMismatchedSnapshot(t *testing.T) {
	a := scopedTestAuthorization(t, "tag:read")
	missingPolicy := a
	missingPolicy.Policy = nil
	for _, actor := range []RequestActor{{Principal: a.Principal}, {Principal: model.Principal{Kind: model.PATCredential, UserID: "another", CredentialID: a.Principal.CredentialID}, Authorization: &a}, {Principal: a.Principal, Authorization: &missingPolicy}} {
		if _, err := TagAuthorizationFromActor(context.Background(), actor); err == nil {
			t.Fatal("invalid authorization accepted")
		}
	}
}
