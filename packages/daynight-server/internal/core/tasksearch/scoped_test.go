package tasksearch

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func searchAuthorization(t *testing.T, kind scopepolicy.CredentialType, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(kind, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	actor := principal()
	profile := model.ScopedPATProfile
	if kind == scopepolicy.MCP {
		actor.Kind = model.OAuthCredential
		profile = model.ScopedMCPProfile
	}
	return model.CredentialAuthorization{Principal: actor, Profile: profile, Policy: &policy}
}

func TestScopedSearchPermissionBeforeSearchFacts(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		t.Run(string(kind), func(t *testing.T) {
			f := testFixture()
			f.failurePhase, f.failure = "fence", errors.New("protected fence read")
			auth := searchAuthorization(t, kind, "project:read")
			_, err := SearchScoped(context.Background(), f, auth, projectID, Request{Query: "cache", Limit: 1})
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
				t.Fatalf("expected scope refusal before fence, got %v", err)
			}
			f.denied = true
			_, err = SearchScoped(context.Background(), f, auth, projectID, Request{Query: "cache", Limit: 1})
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("resource invisibility must precede scope refusal: %v", err)
			}
			f.denied = false
			auth.Policy = nil
			if _, err = SearchScoped(context.Background(), f, auth, projectID, Request{Query: "cache", Limit: 1}); err == nil || errors.Is(err, f.failure) {
				t.Fatalf("invalid policy admitted: %v", err)
			}
		})
	}
}

func TestScopedSearchPreservesPagesWithoutProjectRead(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		t.Run(string(kind), func(t *testing.T) {
			auth := searchAuthorization(t, kind, "task:read")
			request := Request{Query: "cache", Limit: 1}
			legacy, err := Search(context.Background(), testFixture(), auth.Principal, projectID, request)
			if err != nil {
				t.Fatal(err)
			}
			f := testFixture()
			page, err := SearchScoped(context.Background(), f, auth, projectID, request)
			if err != nil || !reflect.DeepEqual(page, legacy) || page.NextCursor == nil {
				t.Fatalf("scoped page diverged: %+v, %v", page, err)
			}
			request.Cursor = page.NextCursor
			f.rows.HasMore = false
			if _, err = SearchScoped(context.Background(), f, auth, projectID, request); err != nil {
				t.Fatalf("continuation rejected: %v", err)
			}
			f.completion = errors.New("snapshot completion failed")
			if _, err = SearchScoped(context.Background(), f, auth, projectID, request); !errors.Is(err, f.completion) {
				t.Fatalf("snapshot completion hidden: %v", err)
			}
		})
	}
}
