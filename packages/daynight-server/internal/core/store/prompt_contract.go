package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type PromptMetadata struct {
	Revision  int64
	UpdatedAt *time.Time
}

type PromptSnapshotReader interface {
	ReadPromptSnapshot(context.Context, func(PromptSnapshot) error) error
}

type PromptSnapshot interface {
	PromptReader
	ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

type PromptReader interface {
	PromptMetadata(context.Context, string, model.PromptScope, string) (PromptMetadata, error)
	PromptText(context.Context, string, model.PromptScope, string) (string, error)
	PromptWorkerExists(context.Context, string, string) error
}

type PromptWriter interface {
	WritePrompt(context.Context, func(PromptWriteScope) error) (Completion, error)
}

type PromptWriteScope interface {
	PromptReader
	PromptResource(context.Context, string, model.PromptScope, string) (model.PromptResource, error)
	LockPromptProject(context.Context, model.Principal, string) error
	CreatePrompt(context.Context, string, model.PromptScope, string, string) (model.PromptResource, error)
	UpdatePrompt(context.Context, string, model.PromptScope, string, int64, int64, string) (model.PromptResource, error)
}
