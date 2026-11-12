package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// LockPurposeCredential preserves MCP's Task message and receipt subset.
// Other user purposes require the fixed API client and audience. The DAO retains
// the token lock and rechecks the grant against the database clock.
func (op *Operation) LockPurposeCredential(ctx context.Context, scope store.SessionScope, p model.Principal, purpose BrowserPurpose) error {
	if p.Kind != model.OAuthCredential {
		return op.LockCredential(ctx, scope, p)
	}
	return op.lockOAuthCredential(ctx, scope, p, purpose == TaskMessageAccess || purpose == TaskReceiptAccess)
}

func (op *Operation) oauthBindings(allowMCP bool) []store.OAuthBinding {
	bindings := []store.OAuthBinding{{Resource: op.engine.Origin + "/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID}}
	if allowMCP {
		bindings = append(bindings, store.OAuthBinding{Resource: op.engine.Origin + "/mcp", Scope: oauth.Scope})
	}
	return bindings
}

func (op *Operation) lockOAuthCredential(ctx context.Context, scope store.SessionScope, p model.Principal, allowMCP bool) error {
	err := scope.SessionDAO().LockOAuthCredential(ctx, p, op.oauthBindings(allowMCP), op.engine.now())
	if errors.Is(err, model.ErrNotFound) {
		return fault("unauthenticated", "Credential expired or was revoked.")
	}
	return err
}

// LoadTaskReceipt reads durable identity without attaching or discarding live state.
func (op *Operation) LoadTaskReceipt(ctx context.Context, scope store.SessionScope, project, taskID, id string) (*Access, error) {
	_, tx := op.scoped(scope)
	location, err := tx.dao.SessionLocation(ctx, id)
	if err != nil {
		return nil, err
	}
	if location.ProjectID != project || location.TaskID != taskID || location.SessionID != id {
		return nil, conflict()
	}
	botID, err := tx.dao.SessionBotID(ctx, id)
	if err != nil {
		return nil, err
	}
	if botID != nil {
		return nil, conflict()
	}
	stored, err := tx.dao.LockSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if stored.Snapshot.SessionID != id {
		return nil, conflict()
	}
	return &Access{tx: tx, record: &record{Snapshot: stored.Snapshot, BotID: stored.BotID, Owner: stored.Owner}}, nil
}

func (op *Operation) BindTaskPurpose(ctx context.Context, a *Access, t *TaskAccess, p model.Principal, project, taskID string, purpose BrowserPurpose) error {
	if purpose == TaskMessageAccess && a.record.BotID != nil {
		return denied()
	}
	if purpose != TaskReceiptAccess {
		return op.BindTaskBrowser(ctx, a, t, p, project, taskID)
	}
	r := a.record
	if project == "" || taskID == "" || r.BotID != nil || r.Snapshot.TestExecutionID != "" || r.Snapshot.Identity.ProjectID != project || r.Snapshot.Identity.TaskID != taskID {
		return conflict()
	}
	a.task = t.task
	return nil
}

// TaskOperationResult preserves the original receipt independently of whether
// its execution is still the Task's current binding.
type TaskOperationResult struct {
	Operation      sp.Operation `json:"operation"`
	CurrentBinding bool         `json:"currentBinding"`
}

// TaskOperation reads only the stored receipt. It never advances Session
// lifecycle, restores a command body, or queues an old execution.
func (s *Execution) TaskOperation(ctx context.Context, p model.Principal, project, taskID, id, operationID string) (TaskOperationResult, error) {
	var out TaskOperationResult
	if project == "" || taskID == "" {
		return out, conflict()
	}
	err := s.browserRun(ctx, p, project, taskID, id, TaskReceiptAccess, func(a *Access) error {
		operation, err := a.tx.dao.SessionOperation(ctx, id, operationID)
		if err != nil {
			return err
		}
		if operation.Receipt.SessionID != id || operation.Receipt.OperationID != operationID || operation.Receipt.ClaimID != a.record.Snapshot.ClaimID {
			return conflict()
		}
		out = TaskOperationResult{Operation: operation.Receipt, CurrentBinding: current(a.task, a.record)}
		return nil
	})
	return out, err
}
