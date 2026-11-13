package task

import (
	"context"
	"errors"
	"io"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func TestTaggedTaskAdmissionReservesRenameAndTouch(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	actual := model.Task{ID: "task", ProjectID: "project", Version: 1, CreatedAt: now, UpdatedAt: now,
		Tags: []model.TagReference{{ID: "first", Name: "a"}, {ID: "second", Name: "b"}}}
	reserved := actual
	reserved.Tags = []model.TagReference{{ID: "first", Name: strings.Repeat("&", 64)}, {ID: "second", Name: strings.Repeat("&", 64)}}
	reserved.Version = math.MaxInt64
	reserved.UpdatedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	size, err := taskprotocol.EncodeREST(io.Discard, reserved, true, taskcore.MaxTaskResponseJSONBytes)
	if err != nil {
		t.Fatal(err)
	}
	actual.Description = strings.Repeat("x", int(taskcore.MaxTaskResponseJSONBytes-size))
	before := actual
	before.Tags = append([]model.TagReference(nil), actual.Tags...)
	if err := admitTaskResponse(context.Background(), actual, true); err != nil {
		t.Fatalf("exact reserved boundary rejected: %v", err)
	}
	if !reflect.DeepEqual(actual, before) {
		t.Fatal("admission changed actual task or tag names")
	}
	actual.Description += "x"
	if _, err := taskprotocol.EncodeREST(io.Discard, actual, true, taskcore.MaxTaskResponseJSONBytes); err != nil {
		t.Fatalf("actual short names should fit: %v", err)
	}
	err = admitTaskResponse(context.Background(), actual, false)
	var violation *limit.Violation
	var fault *model.Fault
	if !errors.As(err, &violation) || !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("reservation overflow not refused: %v", err)
	}
}

func TestUntaggedTaskAdmissionUsesActualValues(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	actual := model.Task{Version: 1, CreatedAt: now, UpdatedAt: now}
	size, err := taskprotocol.EncodeREST(io.Discard, actual, true, taskcore.MaxTaskResponseJSONBytes)
	if err != nil {
		t.Fatal(err)
	}
	actual.Description = strings.Repeat("x", int(taskcore.MaxTaskResponseJSONBytes-size))
	if err := admitTaskResponse(context.Background(), actual, true); err != nil {
		t.Fatalf("untagged exact boundary rejected: %v", err)
	}
}
