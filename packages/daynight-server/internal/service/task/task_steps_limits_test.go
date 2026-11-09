package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskStepsTextLimitsOnAddAndChange(t *testing.T) {
	cases := []struct {
		name, title, description string
		valid                    bool
	}{
		{"title boundary multibyte", strings.Repeat("界", 341) + "x", "", true},
		{"title over multibyte", strings.Repeat("界", 341) + "xx", "", false},
		{"description boundary multibyte", "x", strings.Repeat("界", 21845) + "x", true},
		{"description over multibyte", "x", strings.Repeat("界", 21845) + "xx", false},
		{"escaped boundary", strings.Repeat("<", 1024), strings.Repeat("<", 65536), true},
		{"title over escaped", strings.Repeat("<", 1025), "", false},
		{"description over escaped", "x", strings.Repeat("<", 65537), false},
		{"empty description", "title", "", true},
		{"whitespace title", " \u0085\t", "", false},
		{"nul title", "x\x00", "", false}, {"nul description", "x", "\x00", false},
		{"invalid title UTF-8", string([]byte{0xff}), "", false}, {"invalid description UTF-8", "x", string([]byte{0xff}), false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, operation := range []string{"add", "change"} {
				t.Run(operation, func(t *testing.T) {
					f := newStepWriteFixture(t, stepMutationHeader(1), stepMutationRows(), store.TransactionCommitted)
					before := slices.Clone(f.Current)
					id := fmt.Sprintf("%08x", i+2)
					if operation == "change" {
						id = "00000000"
					}
					var proposed model.TaskStep
					writes, touches := 0, 0
					observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
					if tc.valid {
						f.Writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
							if ctx != f.Ctx {
								t.Fatal("text admission changed clock context")
							}
							return observed, nil
						}
						write := func(ctx context.Context, taskID string, step model.TaskStep) error {
							if ctx != f.Ctx || taskID != f.Header.ID || step.ID != id || step.Title != tc.title || step.Description != tc.description || step.UpdatedAt != observed {
								t.Fatalf("admitted text changed: %+v", step)
							}
							if operation == "add" && (step.Position != 2 || step.CreatedAt != observed) {
								t.Fatal("new Step position/time changed")
							}
							if operation == "change" && (step.Position != 0 || step.CreatedAt != before[0].CreatedAt) {
								t.Fatal("changed Step identity/time changed")
							}
							writes++
							proposed = step
							return nil
						}
						if operation == "add" {
							f.Writer.InsertTaskStepFn = write
						} else {
							f.Writer.UpdateTaskStepFn = write
						}
						f.Writer.TouchTaskFn = func(ctx context.Context, taskID string, at time.Time) error {
							if ctx != f.Ctx || taskID != f.Header.ID || at != observed || writes != 1 {
								t.Fatal("parent touch lost proposed write/time order")
							}
							touches++
							return nil
						}
						post := f.Header
						post.Version++
						f.ExpectCapture(post, func(fact protocol.Fact) {
							if fact.TaskID != f.Header.ID || fact.TaskVersion != post.Version || fact.StepID != id || fact.OccurredAt != observed {
								t.Fatal("text write capture changed identity/version/time")
							}
						})
					}
					var result taskservice.StepsWriteResult
					var err error
					if operation == "add" {
						result, err = f.Steps.Add(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, taskservice.AddTaskStep{Version: 1, ID: id, Title: tc.title, Description: tc.description})
					} else {
						result, err = f.Steps.Update(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, id, taskservice.UpdateTaskStep{Version: 1, Title: &tc.title, Description: &tc.description})
					}
					if !tc.valid {
						requireThreadFault(t, err, "invalid_input")
						if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil || writes != 0 || touches != 0 || !reflect.DeepEqual(before, f.Current) {
							t.Fatalf("text refusal changed input or wrote: %+v", result)
						}
						return
					}
					requireChangeCommitted(t, result, err, true)
					if writes != 1 || touches != 1 || result.Resource.Version != 2 || !reflect.DeepEqual(before, f.Current) {
						t.Fatal("text write altered source rows or lost exact calls")
					}
					var found bool
					for _, step := range result.Resource.Steps {
						if step.ID == id {
							found = step.Title == proposed.Title && step.Description == proposed.Description
						}
					}
					if !found {
						t.Fatal("encoded result did not retain exact admitted text")
					}
				})
			}
		})
	}
}

func TestTaskStepsCollectionLimitRejectsLegalFieldsBeforeWrites(t *testing.T) {
	const count = 170
	body := strings.Repeat("<", 65536)
	at := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	header := stepMutationHeader(1)
	candidate := make([]model.TaskStep, count+1)
	for i := range candidate {
		candidate[i] = model.TaskStep{ID: fmt.Sprintf("%08x", i), Position: int64(i), Title: "x", Description: body, Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	}
	_, encoded, err := taskcodec.EncodeCollection(header, candidate[:count])
	if err != nil || len(encoded) >= taskcodec.MaxEncodedBytes {
		t.Fatalf("170 legal descriptions must fit actual codec: size=%d err=%v", len(encoded), err)
	}
	encoded = nil
	_, _, err = taskcodec.EncodeCollection(header, candidate)
	var limit *taskcodec.LimitError
	if !errors.As(err, &limit) || limit.EncodedBytes <= taskcodec.MaxEncodedBytes {
		t.Fatalf("171 legal descriptions must cross actual codec limit: %v", err)
	}
	current := slices.Clone(candidate)
	current[count].Description = ""
	for _, operation := range []string{"add", "change"} {
		f := newStepWriteFixture(t, header, slices.Clone(current), store.TransactionNotCommitted)
		f.Writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			if ctx != f.Ctx {
				t.Fatal("capacity admission changed clock context")
			}
			return at, nil
		}
		var result taskservice.StepsWriteResult
		if operation == "add" {
			result, err = f.Steps.Add(f.Ctx, f.Principal, header.ProjectID, header.ID, taskservice.AddTaskStep{Version: header.Version, ID: fmt.Sprintf("%08x", count+1), Title: "x", Description: body})
		} else {
			result, err = f.Steps.Update(f.Ctx, f.Principal, header.ProjectID, header.ID, fmt.Sprintf("%08x", count), taskservice.UpdateTaskStep{Version: header.Version, Description: &body})
		}
		requireThreadFault(t, err, "steps_limit_exceeded")
		if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil || result.Changed || f.Header != header || !reflect.DeepEqual(f.Current, current) {
			t.Fatalf("%s capacity refusal changed input/result: %+v", operation, result)
		}
	}
}
