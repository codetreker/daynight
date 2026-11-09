package task

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type Capturer interface {
	CaptureBatch(context.Context, store.WebhookCaptureDAO, []protocol.Fact) error
}

func capturer(optional []Capturer) Capturer {
	if len(optional) != 0 && optional[0] != nil {
		return optional[0]
	}
	return &webhook.Capturer{}
}

func pausedProperty(properties model.TaskProperties) (bool, error) {
	raw, exists := properties["paused"]
	if !exists {
		return false, nil
	}
	var result bool
	if err := json.Unmarshal(raw, &result); err != nil {
		return false, err
	}
	return result, nil
}

func taskFacts(mutationCreate bool, previous, current model.Task) ([]protocol.Fact, error) {
	currentPaused, err := pausedProperty(current.Properties)
	if err != nil {
		return nil, fmt.Errorf("decode current paused property: %w", err)
	}
	base := protocol.Fact{ProjectID: current.ProjectID, TaskID: current.ID, OccurredAt: current.UpdatedAt, TaskVersion: current.Version}
	if mutationCreate {
		base.Type, base.Status, base.Paused, base.OccurredAt = protocol.Created, string(current.Status), currentPaused, current.CreatedAt
		return []protocol.Fact{base}, nil
	}
	previousPaused, err := pausedProperty(previous.Properties)
	if err != nil {
		return nil, fmt.Errorf("decode previous paused property: %w", err)
	}
	facts := make([]protocol.Fact, 0, 2)
	if previous.Status != current.Status {
		f := base
		f.Type, f.PreviousStatus, f.Status = protocol.StatusChanged, string(previous.Status), string(current.Status)
		facts = append(facts, f)
	}
	if !previousPaused && currentPaused {
		f := base
		f.Type, f.Paused = protocol.Paused, true
		facts = append(facts, f)
	}
	return facts, nil
}

func (s *TaskSteps) captureStep(ctx context.Context, tx store.ProjectWriteScope, projectID, taskID, stepID, action string, observed time.Time, from, to *int64, before, after *model.TaskStep) error {
	header, err := tx.TaskDAO().TaskHeader(ctx, taskID)
	if err != nil {
		return err
	}
	f := protocol.Fact{Type: protocol.StepUpdated, ProjectID: projectID, TaskID: taskID, TaskVersion: header.Version, OccurredAt: observed, StepID: stepID, Action: action, FromPosition: from, ToPosition: to}
	if before != nil && after != nil {
		if before.Description != after.Description {
			f.ChangedFields = append(f.ChangedFields, "description")
		}
		if before.Title != after.Title {
			f.ChangedFields = append(f.ChangedFields, "title")
		}
		if before.Status != after.Status {
			f.Action = "status_changed"
			f.PreviousStatus = string(before.Status)
			f.Status = string(after.Status)
		}
	}
	return s.capturer.CaptureBatch(ctx, tx.CaptureDAO(), []protocol.Fact{f})
}
