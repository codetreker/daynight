package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ThreadWriter supplies a transaction without locking the Project. Its scope and
// DAOs remain valid only during the callback.
type ThreadWriter interface {
	WriteThread(context.Context, func(ThreadScope) error) (Completion, error)
}

type ThreadScope interface {
	TaskDAO() ThreadTaskDAO
	CredentialDAO() ThreadCredentialDAO
	ProjectDAO() ThreadProjectDAO
	ThreadDAO() ThreadDAO
}

type ThreadTaskDAO interface {
	LockTaskPresence(context.Context, string, string) (TaskPresence, error)
	SourceTask(context.Context, string, string) (model.Task, error)
}

type ThreadCredentialDAO interface {
	Credential(context.Context, model.Principal) (ThreadCredential, error)
	CredentialValid(context.Context, ThreadCredential) (bool, error)
	AuthorName(context.Context, string) (*string, error)
}

type ThreadProjectDAO interface {
	LockProjectAuthorization(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

type ThreadDAO interface {
	LockHead(context.Context, string) (*model.ThreadPosition, error)
	ThreadMessage(context.Context, string, string) (model.ThreadMessage, error)
	InsertMessage(context.Context, model.ThreadMessage) (model.ThreadMessage, error)
	PrepareTimestamp(context.Context, *model.ThreadMessage, *model.ThreadPosition) error
	AdvanceHead(context.Context, string, model.ThreadPosition) error
}

var _ ThreadWriter = (*Store)(nil)
var _ ThreadScope = (*ThreadTx)(nil)
var _ ThreadTaskDAO = (*ThreadTx)(nil)
var _ ThreadCredentialDAO = (*ThreadTx)(nil)
var _ ThreadProjectDAO = (*ThreadTx)(nil)
var _ ThreadDAO = (*ThreadTx)(nil)
