//go:build stress

package inputlimitinspect

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

func TestStressStepsExactCapacityStreaming(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only")
	}
	for _, extra := range []int64{0, 1} {
		t.Run(fmt.Sprint(extra), func(t *testing.T) {
			var findings []Finding
			i := New(context.Background(), nil, func(store.InputLimitsIdentity) error { return nil }, func(f Finding) error { findings = append(findings, f); return nil })
			if err := i.Identity(store.InputLimitsIdentity{}); err != nil {
				t.Fatal(err)
			}
			timestamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			project := "00000000-0000-4000-8000-000000000001"
			taskID := "00000000-0000-4000-8000-000000000002"
			header := codec.StepsResource{ProjectID: project, TaskID: taskID, Version: 1, Steps: []codec.Step{}}
			headerSize, err := measure.JSON(io.Discard, "steps", codec.MaxEncodedBytes, header, true)
			if err != nil {
				t.Fatal(err)
			}
			total := headerSize + 18
			item := codec.Step{ID: "00000000", Title: "x", Status: model.TaskStepTodo, CreatedAt: timestamp, UpdatedAt: timestamp}
			emptySize, err := measure.JSON(io.Discard, "step", codec.MaxEncodedBytes, item, false)
			if err != nil {
				t.Fatal(err)
			}
			description := strings.Repeat("d", 65536)
			for index := 0; ; index++ {
				comma := int64(0)
				if index > 0 {
					comma = 1
				}
				remaining := int64(codec.MaxEncodedBytes) - total
				length := int64(len(description))
				done := remaining <= comma+emptySize+length
				if done {
					length = remaining - comma - emptySize
					if length < 0 || length > int64(len(description)) {
						t.Fatalf("invalid final padding %d", length)
					}
				} else if remaining-(comma+emptySize+length) < emptySize+1 {
					length = remaining - comma - 2*emptySize - 1
				}
				title := "x"
				if done && extra == 1 {
					title = "xx"
				}
				r := store.InputLimitsRecord{Kind: "step", IDs: map[string]string{"projectId": project, "taskId": taskID, "id": fmt.Sprintf("%08x", index)}, Fields: map[string]store.InputLimitsField{"version": input("1"), "position": input(fmt.Sprint(index)), "status": input("todo"), "createdAt": input("2026-01-01 00:00:00+00"), "updatedAt": input("2026-01-01 00:00:00+00"), "title": input(title), "description": input(description[:length])}}
				if err := i.Record(r); err != nil {
					t.Fatal(err)
				}
				total += comma + emptySize + length
				if done {
					total += extra
				}
				if done {
					break
				}
			}
			if err := i.Finish(); err != nil {
				t.Fatal(err)
			}
			if total != int64(codec.MaxEncodedBytes)+extra {
				t.Fatalf("fixture size %d", total)
			}
			if extra == 0 && (len(findings) != 0 || i.Outcome().Incomplete) {
				t.Fatalf("maximum: %#v", findings)
			}
			if extra == 1 && (len(findings) != 1 || findings[0].Field != "steps" || findings[0].Actual != total) {
				t.Fatalf("maximum+1: %#v", findings)
			}
		})
	}
}
