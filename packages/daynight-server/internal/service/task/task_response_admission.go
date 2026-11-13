package task

import (
	"context"
	"errors"
	"io"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

type mcpTaskResponseKey struct{}

// MCPTaskResponse describes the wire envelope that must fit before a Task write commits.
type MCPTaskResponse struct {
	RequestID string
	RPCID     any
	Modern    bool
	Batch     bool
	Full      bool
}

// WithMCPTaskResponse supplies the request ID used by the MCP success envelope.
// The write admission uses the same encoder and outcome as the tool response.
func WithMCPTaskResponse(ctx context.Context, requestID string, rpcID any, modern, batch, full bool) context.Context {
	return context.WithValue(ctx, mcpTaskResponseKey{}, MCPTaskResponse{RequestID: requestID, RPCID: rpcID, Modern: modern, Batch: batch, Full: full})
}

// MCPTaskResponseFromContext returns the response envelope supplied by the MCP adapter.
// A false result leaves admission independent of MCP framing.
func MCPTaskResponseFromContext(ctx context.Context) (MCPTaskResponse, bool) {
	response, ok := ctx.Value(mcpTaskResponseKey{}).(MCPTaskResponse)
	return response, ok
}

// admitTaskResponse runs after the DAO has produced final timestamps and version
// but before the surrounding transaction commits. Returning its error directly
// from the transaction callback is required to roll back the completed writes.
func admitTaskResponse(ctx context.Context, task model.Task, changed bool) error {
	if len(task.Tags) != 0 {
		// Reserve space for any legal rename and later version/time-only touches.
		// The returned Task and its references must retain their actual values.
		task.Tags = slices.Clone(task.Tags)
		for i := range task.Tags {
			task.Tags[i].Name = strings.Repeat("&", 64)
		}
		task.Version = math.MaxInt64
		task.UpdatedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	}
	for _, extended := range []bool{false, true} {
		if _, err := taskprotocol.EncodeREST(io.Discard, task, extended, taskcore.MaxTaskResponseJSONBytes); err != nil {
			return taskResponseError(err)
		}
	}
	if response, ok := MCPTaskResponseFromContext(ctx); ok {
		outcome := "unchanged"
		if changed {
			outcome = "changed"
		}
		// Single responses leave HTML characters in the outer ID unescaped;
		// legacy JSON batches may escape them when re-encoding RawMessages.
		var difference int64
		if id, ok := response.RPCID.(string); ok && !response.Batch {
			difference = int64(5 * (strings.Count(id, "<") + strings.Count(id, ">") + strings.Count(id, "&")))
		}
		budget := int64(taskcore.MaxTaskResponseJSONBytes) + difference
		if _, err := taskprotocol.EncodeMCPResponse(io.Discard, task, response.RequestID, outcome, response.RPCID, response.Modern, response.Full, budget); err != nil {
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
