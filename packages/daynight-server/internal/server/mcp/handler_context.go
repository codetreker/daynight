package mcp

import (
	"context"
	"errors"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// invocation joins callback lifetime to both request delivery and shutdown.
type invocation struct {
	ctx   context.Context
	actor RequestActor
	scope *requestScope
	done  func()
}

func (e *Entry) beginInvocation(sdkctx context.Context) (*invocation, error) {
	scope, ok := sdkctx.Value(scopeKey{}).(*requestScope)
	if !ok || scope == nil {
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "request scope unavailable"}
	}
	if !e.beginWork() {
		return nil, context.Canceled
	}
	scope.begin()
	ctx, cancel := context.WithCancel(sdkctx)
	stop := context.AfterFunc(scope.actor.Context, cancel)
	// AfterFunc schedules cancellation asynchronously when the actor was
	// already canceled; ensure admission observes it before starting work.
	if scope.actor.Context.Err() != nil {
		cancel()
	}
	actor := scope.actor
	actor.Context = ctx
	var once sync.Once
	return &invocation{ctx: ctx, actor: actor, scope: scope, done: func() {
		once.Do(func() {
			cancel()
			stop()
			scope.end()
			e.active.Done()
		})
	}}, nil
}

// manualHandler reserves control capacity until both callback and HTTP delivery
// end. Each response owns its result objects; only the immutable text is shared.
func (e *Entry) manualHandler(document manualDocument) sdk.ResourceHandler {
	return func(sdkctx context.Context, _ *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		call, err := e.beginInvocation(sdkctx)
		if err != nil {
			return nil, err
		}
		defer call.done()
		release, err := call.actor.Budget.Acquire(call.ctx, BudgetControl)
		if err != nil {
			if errors.Is(err, ErrResourceBusy) {
				e.logger.ErrorContext(call.ctx, "MCP manual admission failed", "type", "operation_error", "component", "mcp", "operation", "manual_read", "document", document.Resource.Name, "phase", "manual_admission", "cause", "resource_busy", "error_code", "resource_busy", "request_id", call.actor.RequestID)
				return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "Internal error"}
			}
			httpx.LogFailure(e.logger.With("operation", "manual_read", "document", document.Resource.Name), call.ctx, "mcp", "manual_admission", err)
			return nil, err
		}
		call.scope.hold(release)
		return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{URI: document.Resource.URI, MIMEType: document.Resource.MIMEType, Text: document.Text}}}, nil
	}
}
