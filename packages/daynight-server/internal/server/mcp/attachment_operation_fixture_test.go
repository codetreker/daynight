package mcp

import (
	"context"
	"errors"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type attachmentUploadOperation func(context.Context, transfercore.Actor, string, string, mcptransfer.UploadInput) (map[string]any, error)

func (operation attachmentUploadOperation) Execute(ctx context.Context, actor transfercore.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
	return operation(ctx, actor, project, task, input)
}

type attachmentReadOperations struct {
	t            *testing.T
	read         func(context.Context, mcptransfer.Actor, mcpdownload.Input) (map[string]any, error)
	readAdmitted func(context.Context, mcptransfer.Actor, mcpdownload.Input, func(context.Context) error) (map[string]any, error)
}

func (operations attachmentReadOperations) Read(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input) (map[string]any, error) {
	if operations.read == nil {
		operations.t.Errorf("unexpected download Read: %+v", input)
		return nil, errors.New("unexpected download Read")
	}
	return operations.read(ctx, actor, input)
}

func (operations attachmentReadOperations) ReadAdmitted(ctx context.Context, actor mcptransfer.Actor, input mcpdownload.Input, admit func(context.Context) error) (map[string]any, error) {
	if operations.readAdmitted == nil {
		operations.t.Errorf("unexpected download ReadAdmitted: %+v", input)
		return nil, errors.New("unexpected download ReadAdmitted")
	}
	return operations.readAdmitted(ctx, actor, input, admit)
}

type attachmentDeleteOperation struct {
	t      *testing.T
	delete func(context.Context, model.Principal, string, string, string) error
}

func (operation attachmentDeleteOperation) Delete(ctx context.Context, principal model.Principal, project, task, path string) error {
	return operation.delete(ctx, principal, project, task, path)
}

func (operation attachmentDeleteOperation) List(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error) {
	operation.t.Error("unexpected attachment List")
	return attachmentcore.Page{}, errors.New("unexpected attachment List")
}
