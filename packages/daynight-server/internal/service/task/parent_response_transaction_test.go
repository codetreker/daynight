package task_test

import (
	"context"
	"errors"
	"io"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestMCPOrdinaryParentResponseBoundaryBeforeCommit(t *testing.T) {
	_, current, _ := taskMockModels()
	parent := "77777777-7777-4777-8777-777777777777"
	current.Type, current.ParentType, current.ParentID = model.TaskTypeTask, model.TaskTypeTask, &parent
	changed := propertyTaskResult(current, current.Properties)
	changed.Title = "Changed"
	base, err := taskprotocol.EncodeMCPResponse(io.Discard, changed, "request", "changed", "", true, true, math.MaxInt64)
	if err != nil {
		t.Fatal(err)
	}
	rpcID := strings.Repeat("x", taskcore.MaxTaskResponseJSONBytes-int(base))
	size, err := taskprotocol.EncodeMCPResponse(io.Discard, changed, "request", "changed", rpcID, true, true, math.MaxInt64)
	if err != nil || size != taskcore.MaxTaskResponseJSONBytes {
		t.Fatalf("default envelope bytes=%d error=%v", size, err)
	}
	for _, expanded := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact default commits", true: "expanded overflow aborts"}[expanded], func(t *testing.T) {
			complete := propertyCommit(t)
			if expanded {
				complete = propertyAbort(t, func(err error) {
					var violation *limit.Violation
					if !errors.As(err, &violation) {
						t.Fatalf("transaction callback lost selected response overflow: %v", err)
					}
				})
			}
			f := newPropertyWriteFixture(t, current, complete)
			f.ctx = taskservice.WithTaskParentView(taskservice.WithMCPTaskResponse(t.Context(), "request", rpcID, true, false, true), expanded)
			f.dao.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
				if ctx != f.ctx || len(ids) != 0 {
					t.Fatal("response admission changed dependencies")
				}
				return []model.Task{}, nil
			}
			want := propertyExpectedWrite(current, current.Properties)
			want.Type, want.ParentID, want.Title = current.Type, current.ParentID, changed.Title
			f.expectUpdate(want, changed, nil)
			if expanded {
				f.wantDrains, f.wantReceipts = 0, 0
			}
			result, err := f.tasks.Update(f.ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: current.Version, Title: &changed.Title})
			if expanded {
				fault, known := operation.KnownFault(err)
				facts := operation.CompletionFacts(err)
				if !known || fault.Code != "resource_limit_exceeded" || facts.Outcome != store.TransactionNotCommitted || !reflect.DeepEqual(result, model.Task{}) {
					t.Fatalf("expanded overflow escaped abort: task=%#v error=%v facts=%+v", result, err, facts)
				}
			} else if err != nil || !reflect.DeepEqual(result, changed) {
				t.Fatalf("default exact boundary failed: task=%#v error=%v", result, err)
			}
		})
	}
}
