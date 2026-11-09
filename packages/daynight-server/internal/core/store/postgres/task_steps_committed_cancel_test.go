package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTaskStepsConfirmedCommitSurvivesCallerCancellation(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	for index, operation := range []string{"add", "change", "status", "delete", "move"} {
		t.Run(operation, func(t *testing.T) {
			task := queryTask(t, database, project.ID, 20+index, model.TaskTodo)
			seedStepWitnessRows(t, database, task.ID, len(stepWitnessIDs))
			parent := stepWitnessState(t, database, task.ID, true)
			beforeHeader, beforeRows := readStepWitnessRows(t, database, project.ID, task.ID)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			// The tracer cancels only after a successful COMMIT result; a lost
			// commit acknowledgement must retain the separate unknown outcome.
			tracer := &stepWriteCancelTracer{fragment: "commit", cancel: cancel}
			config := database.Pool.Config()
			config.ConnConfig.Tracer = tracer
			pool, err := pgxpool.NewWithConfig(t.Context(), config)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			traced := &Store{Pool: pool}
			completion, err := traced.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
				if _, err := scope.TaskDAO().TaskHeader(ctx, task.ID); err != nil {
					return err
				}
				return mutateStepWitness(ctx, scope.TaskDAO(), task.ID, operation)
			})
			if !tracer.observed.Load() || !errors.Is(ctx.Err(), context.Canceled) || err != nil || completion.Outcome != TransactionCommitted {
				t.Fatalf("confirmed commit was reclassified after cancellation: observed=%t context=%v completion=%+v error=%v", tracer.observed.Load(), ctx.Err(), completion, err)
			}
			afterHeader, afterRows := readStepWitnessRows(t, database, project.ID, task.ID)
			expectedHeader := beforeHeader.TaskHeader
			expectedHeader.Version++
			if !reflect.DeepEqual(afterHeader.TaskHeader, expectedHeader) || stepWitnessState(t, database, task.ID, true) != parent {
				t.Fatal("commit lost its shared revision or changed unrelated parent data")
			}
			expectedRows := append([]model.TaskStep{}, beforeRows...)
			switch operation {
			case "add":
				for i := range expectedRows {
					expectedRows[i].Position++
				}
				expectedRows = append([]model.TaskStep{{ID: "12345678", Position: 0, Title: "new", Description: "new body", Status: model.TaskStepTodo, CreatedAt: afterHeader.UpdatedAt, UpdatedAt: afterHeader.UpdatedAt}}, expectedRows...)
			case "change":
				expectedRows[0].Title, expectedRows[0].Description = "new title", "new description"
				expectedRows[0].UpdatedAt = afterHeader.UpdatedAt
			case "status":
				expectedRows[0].Status = model.TaskStepDone
				expectedRows[0].UpdatedAt = afterHeader.UpdatedAt
			case "delete":
				expectedRows = expectedRows[1:]
				for i := range expectedRows {
					expectedRows[i].Position = int64(i)
				}
			case "move":
				expectedRows = append(expectedRows[1:], expectedRows[0])
				for i := range expectedRows {
					expectedRows[i].Position = int64(i)
				}
			}
			if !reflect.DeepEqual(afterRows, expectedRows) {
				t.Fatalf("confirmed commit did not persist exact child state: expected=%#v actual=%#v", expectedRows, afterRows)
			}
			readHeader, readRows := readStepWitnessRows(t, database, project.ID, task.ID)
			if !reflect.DeepEqual(readHeader, afterHeader) || !reflect.DeepEqual(readRows, afterRows) {
				t.Fatal("reconciliation changed the committed revision or child collection")
			}
			assertMigrationPoolReusable(t, pool)
		})
	}
}
