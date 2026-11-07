package inputlimitinspect

import (
	"encoding/json"
	"io"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
	taskwire "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func (i *Inspector) task(r store.InputLimitsRecord) error {
	if err := i.textLimit(r, "title", text.MaxTitleBytes, false); err != nil {
		return err
	}
	if err := i.textLimit(r, "description", text.MaxDescriptionBytes, false); err != nil {
		return err
	}
	count, ok := r.Numbers["dependencies"]
	if !ok {
		return i.incomplete(r, "dependencies", "missing dependency count")
	}
	if count > task.MaxDependencies {
		if err := i.finding(r, "dependsOn", "violation", "", count, task.MaxDependencies, "items", false); err != nil {
			return err
		}
	}
	if !r.CandidateComplete {
		return i.incomplete(r, "task", "candidate exceeds inspection budget")
	}
	title, a := field(r, "title")
	desc, b := field(r, "description")
	status, c := field(r, "status")
	version, d := field(r, "version")
	created, e := field(r, "createdAt")
	updated, f := field(r, "updatedAt")
	allow, g := field(r, "allowAgents")
	ready, h := field(r, "ready")
	if !a || !b || !c || !d || !e || !f || !g || !h {
		return i.incomplete(r, "task", "required fields unavailable")
	}
	t := model.Task{ID: r.IDs["id"], ProjectID: r.IDs["projectId"], Title: title, Description: desc, Status: model.TaskStatus(status), DependsOn: r.Dependencies, ExternalDependsOn: r.ExternalDependencies, BlockedBy: r.BlockedBy, Properties: make(model.TaskProperties, len(r.Properties))}
	var err error
	t.Version, err = strconv.ParseInt(version, 10, 64)
	if err != nil {
		return i.incomplete(r, "version", "invalid stored version")
	}
	t.CreatedAt, err = parseTime(created)
	if err != nil {
		return i.incomplete(r, "createdAt", "invalid stored timestamp")
	}
	t.UpdatedAt, err = parseTime(updated)
	if err != nil {
		return i.incomplete(r, "updatedAt", "invalid stored timestamp")
	}
	t.AllowAgents, err = strconv.ParseBool(allow)
	if err != nil {
		return i.incomplete(r, "allowAgents", "invalid stored value")
	}
	t.Ready, err = strconv.ParseBool(ready)
	if err != nil {
		return i.incomplete(r, "ready", "invalid stored value")
	}
	for key, target := range map[string]**time.Time{"startedAt": &t.StartedAt, "completedAt": &t.CompletedAt, "cancelledAt": &t.CancelledAt} {
		raw, ok := optional(r, key)
		if !ok {
			return i.incomplete(r, key, "missing stored field")
		}
		if raw != nil {
			value, err := parseTime(*raw)
			if err != nil {
				return i.incomplete(r, key, "invalid stored timestamp")
			}
			*target = &value
		}
	}
	platform, ok := optional(r, "requiredPlatform")
	if !ok {
		return i.incomplete(r, "requiredPlatform", "missing stored field")
	}
	if platform != nil {
		p := model.TaskPlatform(*platform)
		t.RequiredPlatform = &p
	}
	t.AssignedTo, ok = optional(r, "assignedTo")
	if !ok {
		return i.incomplete(r, "assignedTo", "missing stored field")
	}
	var normalizedBound int64
	for _, raw := range r.Properties {
		normalizedBound += normalizationBound(raw)
	}
	if normalizedBound > normalizedBudget {
		return i.incomplete(r, "properties", "normalization budget cannot be established")
	}
	for name, raw := range r.Properties {
		if normalizationBound(raw) > normalizedBudget {
			return i.incomplete(r, "properties", "normalization budget cannot be established")
		}
		normalized, err := taskproperty.NormalizeValue(name, json.RawMessage(raw))
		if err != nil {
			return i.violation(r, err)
		}
		t.Properties[name] = normalized
	}
	if err = i.violation(r, text.Admit(title, desc)); err != nil {
		return err
	}
	_, err = taskwire.EncodeREST(io.Discard, t, true, task.MaxTaskResponseJSONBytes)
	if err = i.violation(r, err); err != nil {
		return err
	}
	_, err = taskwire.EncodeREST(io.Discard, t, false, task.MaxTaskResponseJSONBytes)
	if err = i.violation(r, err); err != nil {
		return err
	}
	_, err = taskwire.EncodeMCP(io.Discard, t, "00000000-0000-0000-0000-000000000000", "", task.MaxTaskResponseJSONBytes)
	return i.violation(r, err)
}

type stepGroup struct {
	taskID string
	record store.InputLimitsRecord
	bytes  int64
	count  int64
	valid  bool
}

func (i *Inspector) finishSteps() error {
	if i.steps.taskID == "" {
		return nil
	}
	group := i.steps
	i.steps = stepGroup{}
	if !group.valid {
		return nil
	}
	if group.bytes > codec.MaxEncodedBytes {
		return i.finding(group.record, "steps", "violation", "", group.bytes, codec.MaxEncodedBytes, "bytes", false)
	}
	return nil
}
func (i *Inspector) step(r store.InputLimitsRecord) error {
	if i.steps.taskID != r.IDs["taskId"] {
		if err := i.finishSteps(); err != nil {
			return err
		}
		version, ok := field(r, "version")
		if !ok {
			return i.incomplete(r, "version", "step parent unavailable")
		}
		v, err := strconv.ParseInt(version, 10, 64)
		if err != nil || v < 1 {
			return i.incomplete(r, "version", "invalid step parent version")
		}
		// The resource has a 19-digit reserved version in capacity checks.
		header := codec.StepsResource{ProjectID: r.IDs["projectId"], TaskID: r.IDs["taskId"], Version: v, Steps: []codec.Step{}}
		data, err := json.Marshal(header)
		if err != nil {
			return err
		}
		i.steps = stepGroup{taskID: r.IDs["taskId"], record: store.InputLimitsRecord{Kind: "stepCollection", IDs: copyIDs(r.IDs)}, bytes: int64(len(data) + 1 + 19 - len(version)), valid: true}
	}
	if err := i.textLimit(r, "title", text.MaxTitleBytes, false); err != nil {
		return err
	}
	if err := i.textLimit(r, "description", text.MaxDescriptionBytes, false); err != nil {
		return err
	}
	title, a := field(r, "title")
	desc, b := field(r, "description")
	status, c := field(r, "status")
	created, d := field(r, "createdAt")
	updated, e := field(r, "updatedAt")
	position, f := field(r, "position")
	if !a || !b || !c || !d || !e || !f {
		i.steps.valid = false
		return i.incomplete(r, "step", "candidate exceeds inspection budget or is missing")
	}
	pos, err := strconv.ParseInt(position, 10, 64)
	if err != nil {
		i.steps.valid = false
		return i.incomplete(r, "position", "invalid stored position")
	}
	createdTime, err := parseTime(created)
	if err != nil {
		i.steps.valid = false
		return i.incomplete(r, "createdAt", "invalid stored timestamp")
	}
	updatedTime, err := parseTime(updated)
	if err != nil {
		i.steps.valid = false
		return i.incomplete(r, "updatedAt", "invalid stored timestamp")
	}
	value := model.TaskStep{ID: r.IDs["id"], Position: pos, Title: title, Description: desc, Status: model.TaskStepStatus(status), CreatedAt: createdTime, UpdatedAt: updatedTime}
	if err = codec.ValidateStep(value); err != nil || pos != i.steps.count {
		i.steps.valid = false
		return i.incomplete(r, "step", "invalid stored step")
	}
	if err = i.violation(r, text.Admit(title, desc)); err != nil {
		return err
	}
	size, err := measure.JSON(io.Discard, "step", normalizedBudget, codec.Step{ID: value.ID, Title: title, Description: desc, Status: value.Status, CreatedAt: createdTime, UpdatedAt: updatedTime}, false)
	if err != nil {
		i.steps.valid = false
		return i.incomplete(r, "step", "normalization budget exceeded")
	}
	i.steps.bytes += size
	if i.steps.count > 0 {
		i.steps.bytes++
	}
	i.steps.count++
	return nil
}
