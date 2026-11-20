package task

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type ScopedThreadService interface {
	Post(context.Context, model.CredentialAuthorization, string, string, service.CreateThreadMessage) (service.ThreadMessageDocument, error)
	List(context.Context, model.CredentialAuthorization, string, string, service.ThreadListRequest) (service.ThreadPageDocument, error)
}

type ThreadAuthorizedHandler = func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)
type ThreadScopedAuthentication interface {
	RequireAuthorization(ThreadAuthorizedHandler) http.HandlerFunc
}

type authorizedThreadService struct {
	service ScopedThreadService
	auth    model.CredentialAuthorization
}

func (s authorizedThreadService) Post(ctx context.Context, p model.Principal, project, task string, input service.CreateThreadMessage) (service.ThreadMessageDocument, error) {
	if p != s.auth.Principal {
		return service.ThreadMessageDocument{}, model.Unauthenticated(nil)
	}
	return s.service.Post(ctx, s.auth, project, task, input)
}
func (s authorizedThreadService) List(ctx context.Context, p model.Principal, project, task string, input service.ThreadListRequest) (service.ThreadPageDocument, error) {
	if p != s.auth.Principal {
		return service.ThreadPageDocument{}, model.Unauthenticated(nil)
	}
	return s.service.List(ctx, s.auth, project, task, input)
}

// ScopedTaskThreadRoutes retains the existing HTTP protocol and Bot admission.
func ScopedTaskThreadRoutes(mux httpx.RouteRegistrar, threads ScopedThreadService, auth ThreadScopedAuthentication, logger *slog.Logger) {
	ScopedTaskThreadRoutesObserved(mux, threads, auth, logger, nil)
}

// ThreadScopeRoute records both the legacy full response and receipt branches.
type ThreadScopeRoute struct {
	Pattern           string
	Operations        []scopepolicy.Operation
	ReceiptOperations []scopepolicy.Operation
	Fallback          bool
}

func ScopedTaskThreadRoutesObserved(mux httpx.RouteRegistrar, threads ScopedThreadService, auth ThreadScopedAuthentication, logger *slog.Logger, observe func(ThreadScopeRoute)) {
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/thread/messages"
	wrap := func(operation string) http.HandlerFunc {
		return auth.RequireAuthorization(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
			if err := a.Validate(); err != nil {
				writeThreadError(w, r, logger, "authorization", err)
				return
			}
			h := &taskThreadHandler{threads: authorizedThreadService{threads, a}, logger: logger, scoped: true}
			switch operation {
			case "read":
				h.list(w, r, a.Principal)
			case "post":
				declaredBot(logger, threadBotRefusal, h.post)(w, r, a.Principal)
			default:
				httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")(w, r, a.Principal)
			}
		})
	}
	register := func(entry ThreadScopeRoute, handler http.HandlerFunc) {
		mux.HandleFunc(entry.Pattern, handler)
		if observe != nil {
			observe(entry)
			if strings.HasPrefix(entry.Pattern, "GET ") {
				entry.Pattern = "HEAD " + strings.TrimPrefix(entry.Pattern, "GET ")
				observe(entry)
			}
		}
	}
	register(ThreadScopeRoute{Pattern: "GET " + path, Operations: []scopepolicy.Operation{scopepolicy.ThreadRead}}, wrap("read"))
	register(ThreadScopeRoute{Pattern: "POST " + path, Operations: []scopepolicy.Operation{scopepolicy.ThreadPost, scopepolicy.ThreadRead}, ReceiptOperations: []scopepolicy.Operation{scopepolicy.ThreadPost}}, wrap("post"))
	register(ThreadScopeRoute{Pattern: path, Fallback: true}, wrap("fallback"))
}
