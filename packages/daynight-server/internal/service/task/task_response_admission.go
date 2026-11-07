package task

import (
	"context"
	"errors"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

type mcpTaskResponseKey struct{}

// WithMCPTaskResponse supplies the request ID used by the MCP success envelope.
// The write admission uses the same encoder and outcome as the tool response.
func WithMCPTaskResponse(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, mcpTaskResponseKey{}, requestID)
}

// admitTaskResponse runs after the DAO has produced final timestamps and version
// but before the surrounding transaction commits. Returning its error directly
// from the transaction callback is required to roll back the completed writes.
func admitTaskResponse(ctx context.Context, task model.Task, changed bool) error {
	for _, extended := range []bool{false, true} {
		if _, err := taskprotocol.EncodeREST(io.Discard, task, extended, taskcore.MaxTaskResponseJSONBytes); err != nil {
			return taskResponseError(err)
		}
	}
	if requestID, ok := ctx.Value(mcpTaskResponseKey{}).(string); ok {
		outcome := "unchanged"
		if changed {
			outcome = "changed"
		}
		if _, err := taskprotocol.EncodeMCP(io.Discard, task, requestID, outcome, taskcore.MaxTaskResponseJSONBytes); err != nil {
			return taskResponseError(err)
		}
	}
	return nil
}

func taskResponseError(err error) error {
	var violation *limit.Violation
	if errors.As(err, &violation) || errors.Is(err, taskprotocol.ErrLegacyWorkerIndeterminate) {
		return &model.Fault{Code: "resource_limit_exceeded", Message: "Task response exceeds the encoded resource limit.", Cause: err}
	}
	return err
}
