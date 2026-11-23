package server

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProductionAssistantPollingRenewsOnlySupportedMethods(t *testing.T) {
	database, plan := newIdentityHTTPPlan(t)
	server := resourceScopeServer(t, database, attachmentTestFiles(t), io.Discard)
	browser := identityBrowser(t)
	user := identityHTTPUser("alice")
	token := httpTestToken(model.SessionCredential)
	resourceScopeCookie(t, browser, server.URL, token)
	headers := map[string]string{"Origin": server.URL, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			plan.activity(user, token)
			dao := &activityAssistantDAO{t: t, principal: identityHTTPPrincipal(user, model.SessionCredential)}
			writes := 0
			database.WriteAssistantTaskCall = func(ctx context.Context, next func(store.AssistantTaskScope) error) (store.Completion, error) {
				writes++
				if writes != 1 || ctx.Err() != nil {
					t.Fatal("unexpected assistant task transaction")
				}
				err := next(dao)
				return store.Completion{Outcome: store.TransactionCommitted}, err
			}
			response, _ := identityRequest(t, browser, method, server.URL+"/api/v1/assistant-tasks", "", headers, http.StatusOK)
			if writes != 1 || dao.position != 4 || len(response.Cookies()) != 0 {
				t.Fatal("assistant polling did not complete its authenticated business read")
			}
		})
	}
	database.WriteAssistantTaskCall = func(context.Context, func(store.AssistantTaskScope) error) (store.Completion, error) {
		t.Fatal("method refusal entered assistant business transaction")
		return store.Completion{}, nil
	}
	for _, method := range []string{http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		plan.authenticate(user, model.SessionCredential, token, true)
		response, _ := identityRequest(t, browser, method, server.URL+"/api/v1/assistant-tasks", "", headers, http.StatusMethodNotAllowed)
		if response.Header.Get("Allow") != "GET, HEAD, POST" || len(response.Cookies()) != 0 {
			t.Fatal("assistant method refusal changed its protocol")
		}
	}
	plan.authenticate(user, model.SessionCredential, token, true)
	identityRequest(t, browser, http.MethodPost, server.URL+"/api/v1/assistant-tasks", "{}", map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}, http.StatusForbidden)
}

func TestProductionOAuthConsentDispatchActivity(t *testing.T) {
	database, plan := newIdentityHTTPPlan(t)
	server := resourceScopeServer(t, database, attachmentTestFiles(t), io.Discard)
	browser := identityBrowser(t)
	user := identityHTTPUser("alice")
	token := httpTestToken(model.SessionCredential)
	resourceScopeCookie(t, browser, server.URL, token)
	headers := map[string]string{"Origin": server.URL, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}
	path := "/api/v1/oauth/requests/10000000-0000-4000-8000-000000000001"
	for _, route := range []struct{ method, path string }{{"GET", path}, {"POST", path + "/decision"}} {
		plan.activity(user, token)
		// A missing one-time binding is a business refusal after session admission.
		response, _ := identityRequest(t, browser, route.method, server.URL+route.path, "", headers, http.StatusNotFound)
		if len(response.Cookies()) != 0 {
			t.Fatal("consent activity reissued a Cookie")
		}
	}
	for _, route := range []struct{ method, path string }{{"HEAD", path}, {"POST", path}, {"GET", path + "/decision"}, {"HEAD", path + "/decision"}, {"DELETE", path + "/decision"}} {
		identityRequest(t, browser, route.method, server.URL+route.path, "", headers, http.StatusMethodNotAllowed)
	}
	identityRequest(t, browser, "POST", server.URL+path+"/decision", "", map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}, http.StatusForbidden)
}

type activityAssistantContract interface{ store.AssistantTaskDAO }

type activityAssistantDAO struct {
	activityAssistantContract
	t         *testing.T
	principal model.Principal
	position  int
}

func (d *activityAssistantDAO) AssistantTaskDAO() store.AssistantTaskDAO { return d }
func (d *activityAssistantDAO) Credential(ctx context.Context, p model.Principal) error {
	if ctx.Err() != nil || p != d.principal || d.position != 0 && d.position != 2 {
		d.t.Fatal("assistant credential check lost ordering or principal")
	}
	d.position++
	return nil
}
func (d *activityAssistantDAO) Tasks(ctx context.Context, query store.AssistantTaskQuery) ([]model.AssistantTask, error) {
	if ctx.Err() != nil || d.position != 1 || query.OwnerUserID != d.principal.UserID || query.Limit != 50 || query.TaskID != "" {
		d.t.Fatal("assistant polling lost owner or initial page")
	}
	d.position++
	return []model.AssistantTask{}, nil
}
func (d *activityAssistantDAO) Now(ctx context.Context) (time.Time, error) {
	if ctx.Err() != nil || d.position != 3 {
		d.t.Fatal("assistant page clock read before final credential check")
	}
	d.position++
	return time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC), nil
}
