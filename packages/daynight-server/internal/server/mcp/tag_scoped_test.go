package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
)

type scopedTagOperations struct {
	ScopedTagOperations
	t     *testing.T
	check func(context.Context, model.CredentialAuthorization, string, string)
}

func (o scopedTagOperations) refusal(ctx context.Context, a model.CredentialAuthorization, project, operation string) error {
	o.t.Helper()
	o.check(ctx, a, project, operation)
	return &model.Fault{Code: "insufficient_scope", Message: "Tag scope is insufficient."}
}
func (o scopedTagOperations) List(ctx context.Context, a model.CredentialAuthorization, project string, in tagservice.ListInput) (tagservice.Page, error) {
	if in.Query != "alpha" || in.Limit != 7 || in.Cursor != "opaque" {
		o.t.Fatal("list input changed")
	}
	return tagservice.Page{}, o.refusal(ctx, a, project, "tag_list")
}
func (o scopedTagOperations) Get(ctx context.Context, a model.CredentialAuthorization, project, id string) (tagservice.Item, error) {
	if id != testTargetID {
		o.t.Fatal(id)
	}
	return tagservice.Item{}, o.refusal(ctx, a, project, "tag_show")
}
func (o scopedTagOperations) Create(ctx context.Context, a model.CredentialAuthorization, project, name string, color *string) (tagservice.WriteResult, error) {
	if name != "Alpha" || color == nil || *color != "#123456" {
		o.t.Fatal("create input changed")
	}
	return tagservice.WriteResult{Outcome: store.TransactionNotCommitted}, o.refusal(ctx, a, project, "tag_create")
}
func (o scopedTagOperations) Update(ctx context.Context, a model.CredentialAuthorization, project, id string, v int64, name, color *string) (tagservice.WriteResult, error) {
	if id != testTargetID || v != 9007199254740993 || name == nil || *name != "Alpha" {
		o.t.Fatal("update input changed")
	}
	operation := "tag_rename"
	if color != nil {
		if *color != "#123456" {
			o.t.Fatal(*color)
		}
		operation = "tag_update"
	}
	return tagservice.WriteResult{Outcome: store.TransactionNotCommitted}, o.refusal(ctx, a, project, operation)
}
func (o scopedTagOperations) Delete(ctx context.Context, a model.CredentialAuthorization, project, id string, v int64, confirm bool) (tagservice.WriteResult, error) {
	if id != testTargetID || v != 9007199254740993 || !confirm {
		o.t.Fatal("delete input changed")
	}
	return tagservice.WriteResult{Outcome: store.TransactionNotCommitted}, o.refusal(ctx, a, project, "tag_delete")
}
func tagScopedAuthorization(t *testing.T) model.CredentialAuthorization {
	t.Helper()
	p, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"tag:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: testProjectID, CredentialID: testTargetID}, Profile: model.ScopedPATProfile, Policy: &p}
}
func TestScopedTagToolsPreserveDiscoveryAndRefusals(t *testing.T) {
	legacy := newEntryFixture(t)
	if err := RegisterTagTools(legacy.entry, tagTestOperations{t: t}); err != nil {
		t.Fatal(err)
	}
	baseline, err := legacy.client(t, "2026-07-28", "alice").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	candidate := newEntryFixture(t)
	candidate.entry.auth = tagColorTestAuthenticator{}
	authorization := tagScopedAuthorization(t)
	var seen string
	var calls int
	ops := scopedTagOperations{t: t, check: func(ctx context.Context, a model.CredentialAuthorization, project, operation string) {
		if ctx.Err() != nil || a != authorization || project != testProjectID || seen != "" {
			t.Fatalf("authorization/context/project changed: %+v %q %q", a, project, seen)
		}
		seen = operation
	}}
	resolver := func(ctx context.Context, actor RequestActor) (model.CredentialAuthorization, error) {
		calls++
		if ctx.Err() != nil || actor.Principal != authorization.Principal || actor.AuthorityRef.Kind != "pat" || actor.AuthorityRef.ID != testTargetID {
			t.Fatalf("actor changed: %+v", actor)
		}
		return authorization, nil
	}
	if err := RegisterScopedTagTools(candidate.entry, ops, resolver); err != nil {
		t.Fatal(err)
	}
	client := candidate.client(t, "2026-07-28", "alice")
	listing, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(baseline)
	after, _ := json.Marshal(listing)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("discovery changed: before=%s after=%s", before, after)
	}
	if calls != 0 {
		t.Fatal("discovery queried business authorization")
	}
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"tag_list", map[string]any{"projectId": testProjectID, "query": "alpha", "limit": 7, "cursor": "opaque"}},
		{"tag_show", map[string]any{"projectId": testProjectID, "tagId": testTargetID}},
		{"tag_create", map[string]any{"projectId": testProjectID, "name": "Alpha", "color": "#123456"}},
		{"tag_rename", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "9007199254740993", "name": "Alpha"}},
		{"tag_update", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "9007199254740993", "name": "Alpha", "color": "#123456"}},
		{"tag_delete", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "9007199254740993", "confirm": true}},
	} {
		seen = ""
		result := tagTestCall(t, client, tc.name, tc.args)
		env := structured(t, result)
		failure := object(t, env["error"])
		if !result.IsError || failure["code"] != "insufficient_scope" || seen != tc.name || env["data"] != nil {
			t.Fatalf("%s: %v seen=%q", tc.name, env, seen)
		}
		if tc.name != "tag_list" && tc.name != "tag_show" && failure["writeOutcome"] != "not_committed" {
			t.Fatal(failure)
		}
	}
	if calls != 6 {
		t.Fatalf("authorization calls=%d", calls)
	}
	t.Logf("unchanged MCP tools/list bytes=%d", len(after))
}
func TestScopedTagToolAuthorizationFailuresNeverInvokeBusiness(t *testing.T) {
	for _, tc := range []string{"missing policy", "identity mismatch", "resolver refusal"} {
		t.Run(tc, func(t *testing.T) {
			f := newEntryFixture(t)
			f.entry.auth = tagColorTestAuthenticator{}
			ops := scopedTagOperations{t: t, check: func(context.Context, model.CredentialAuthorization, string, string) {
				t.Fatal("business invoked after authorization failure")
			}}
			resolver := func(context.Context, RequestActor) (model.CredentialAuthorization, error) {
				a := tagScopedAuthorization(t)
				switch tc {
				case "missing policy":
					a.Policy = nil
				case "identity mismatch":
					a.Principal.CredentialID = testProjectID
				case "resolver refusal":
					return a, errors.New("private authorization error")
				}
				return a, nil
			}
			if err := RegisterScopedTagTools(f.entry, ops, resolver); err != nil {
				t.Fatal(err)
			}
			result := tagTestCall(t, f.client(t, "2026-07-28", "alice"), "tag_delete", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "1", "confirm": true})
			env := structured(t, result)
			failure := object(t, env["error"])
			encoded, _ := json.Marshal(env)
			if !result.IsError || failure["code"] != "internal_error" || failure["writeOutcome"] != "not_committed" || strings.Contains(string(encoded), "private authorization") {
				t.Fatal(string(encoded))
			}
		})
	}
	if err := RegisterScopedTagTools(nil, scopedTagOperations{}, nil); err == nil {
		t.Fatal("missing resolver accepted")
	}
}
