package prompt

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

type scopedHTTPAuth struct{ value model.CredentialAuthorization }

func (a *scopedHTTPAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.value) }
}

type scopedHTTPPrompts struct {
	gets, puts int
	received   model.CredentialAuthorization
}

func (p *scopedHTTPPrompts) GetAuthorized(_ context.Context, auth model.CredentialAuthorization, scope model.PromptScope, id string) (model.PromptResource, error) {
	p.gets++
	p.received = auth
	if err := scopeadmission.Require(auth, scopepolicy.PromptRead); err != nil {
		return model.PromptResource{}, err
	}
	return model.PromptResource{Scope: scope, ScopeID: id, Revision: "0"}, nil
}
func (p *scopedHTTPPrompts) PutAuthorized(_ context.Context, auth model.CredentialAuthorization, scope model.PromptScope, id, expected, revision, text string) (model.PromptResource, error) {
	p.puts++
	p.received = auth
	if err := scopeadmission.Require(auth, scopepolicy.PromptRead, scopepolicy.PromptWrite); err != nil {
		return model.PromptResource{}, err
	}
	return model.PromptResource{Scope: scope, ScopeID: id, Revision: revision, Text: text}, nil
}
func TestScopedPromptHTTPAssembly(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"prompt:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := &scopedHTTPAuth{value: model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: userID, CredentialID: resourceID}, Profile: model.ScopedPATProfile, Policy: &policy}}
	p := &scopedHTTPPrompts{}
	mux := http.NewServeMux()
	RegisterScopedRoutes(mux, p, a, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, "/api/v1/me/worker-prompt", nil))
		if w.Code != 200 || p.received.Principal != a.value.Principal || p.received.Policy != a.value.Policy {
			t.Fatalf("%s: %d %s", method, w.Code, w.Body)
		}
	}
	body := fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"new"}`, userID)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("PUT", "/api/v1/me/worker-prompt", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(w, r)
	if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || p.puts != 1 {
		t.Fatalf("PUT denial %d %v %s", w.Code, w.Header(), w.Body)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/me/worker-prompt", nil))
	if w.Code != 405 || p.gets != 2 || p.puts != 1 {
		t.Fatalf("fallback %d", w.Code)
	}
}
