package worker

import (
	"bytes"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func workerRuntimeConfigurationInput(raw json.RawMessage) (*model.WorkerRuntimeConfiguration, error) {
	fields, err := workerObject(raw, "runtimeConfiguration", "schemaVersion", "native", "projects")
	if err != nil {
		return nil, err
	}
	result := &model.WorkerRuntimeConfiguration{}
	result.SchemaVersion, err = workerIntegerInput(fields["schemaVersion"])
	if err != nil {
		return nil, err
	}
	result.Native, err = workerRuntimeNativeInput(fields["native"])
	if err != nil {
		return nil, err
	}
	var projects []json.RawMessage
	if json.Unmarshal(fields["projects"], &projects) != nil || projects == nil || len(projects) > 1024 {
		return nil, httpx.InvalidInput("runtimeConfiguration.projects must be an array of at most 1024 projects")
	}
	result.Projects = make([]model.WorkerRuntimeProject, 0, len(projects))
	for _, raw := range projects {
		fields, err := workerObject(raw, "runtimeConfiguration.projects", "projectId", "native")
		if err != nil {
			return nil, err
		}
		projectID, err := httpx.RequiredString(fields, "projectId")
		if err != nil {
			return nil, err
		}
		native, err := workerRuntimeNativeInput(fields["native"])
		if err != nil {
			return nil, err
		}
		result.Projects = append(result.Projects, model.WorkerRuntimeProject{ProjectID: projectID, Native: native})
	}
	return result, nil
}

func workerRuntimeNativeInput(raw json.RawMessage) (*model.WorkerRuntimeNative, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	fields, err := workerObject(raw, "runtimeConfiguration.native", "agent", "model", "reasoningEffort")
	if err != nil {
		return nil, err
	}
	agent, err := httpx.RequiredString(fields, "agent")
	if err != nil {
		return nil, err
	}
	result := &model.WorkerRuntimeNative{Agent: model.WorkerAgent(agent)}
	result.Model, err = workerConfigurationValueInput(fields["model"])
	if err != nil {
		return nil, err
	}
	result.ReasoningEffort, err = workerConfigurationValueInput(fields["reasoningEffort"])
	return result, err
}

func workerConfigurationValueInput(raw json.RawMessage) (model.WorkerConfigurationValue, error) {
	var result model.WorkerConfigurationValue
	fields, err := workerObject(raw, "runtimeConfiguration value", "value", "source")
	if err != nil {
		return result, err
	}
	result.Source, err = httpx.RequiredString(fields, "source")
	if err != nil {
		return result, err
	}
	if !bytes.Equal(bytes.TrimSpace(fields["value"]), []byte("null")) {
		value, err := httpx.RequiredString(fields, "value")
		if err != nil {
			return result, err
		}
		result.Value = &value
	}
	return result, nil
}
