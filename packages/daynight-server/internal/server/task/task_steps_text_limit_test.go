package task_test

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestStepsHTTPTextAdmission(t *testing.T) {
	cases := []struct{ name, field, valid, excess string }{
		{"title", "title", strings.Repeat("é", 512), strings.Repeat("é", 512) + "x"},
		{"description", "description", strings.Repeat("\x01", 65536), strings.Repeat("\x01", 65536) + "x"},
	}
	for _, tc := range cases {
		for _, operation := range []string{"add", "update"} {
			for _, admitted := range []bool{true, false} {
				name := tc.name + "/" + operation + "/refused"
				if admitted {
					name = tc.name + "/" + operation + "/admitted"
				}
				t.Run(name, func(t *testing.T) {
					h := newHTTPFixture(t, io.Discard)
					text := tc.excess
					if admitted {
						text = tc.valid
					}
					row := stepHTTPRows()[0]
					row.Title, row.Description = "x", ""
					if tc.field == "title" {
						row.Title = text
					} else {
						row.Description = text
					}
					result := stepHTTPWrite(t, 2, []api.TaskStep{row}, true)
					finish := func() (taskservice.StepsWriteResult, error) {
						if !admitted {
							return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: "invalid_input", Message: "Step text exceeds its allowed bytes."}
						}
						return result, nil
					}
					method, endpoint := "POST", stepHTTPPath()
					values := map[string]any{"version": 1, "id": "abcdef01", "title": "x", tc.field: text}
					if operation == "add" {
						h.Steps.AddFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
							checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
							if input.ID != "abcdef01" || input.Version != 1 || input.Title != row.Title || input.Description != row.Description {
								t.Fatal("text bytes changed before Add")
							}
							return finish()
						}
					} else {
						method, endpoint = "PATCH", stepHTTPPath()+"/abcdef01"
						values = map[string]any{"version": 1, tc.field: text}
						h.Steps.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
							checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
							if id != "abcdef01" || input.Version != 1 || tc.field == "title" && (input.Title == nil || *input.Title != text || input.Description != nil) || tc.field == "description" && (input.Description == nil || *input.Description != text || input.Title != nil) {
								t.Fatal("text bytes or field presence changed before Update")
							}
							return finish()
						}
					}
					response := projectRequest(h, method, endpoint, jsonBody(t, values))
					if !admitted {
						assertProjectError(t, response, 400, "invalid_input")
						return
					}
					status := 200
					if operation == "add" {
						status = 201
					}
					if response.Code != status || !bytes.Equal(response.Body.Bytes(), result.JSON) {
						t.Fatal("admitted text receipt changed")
					}
				})
			}
		}
	}
}
