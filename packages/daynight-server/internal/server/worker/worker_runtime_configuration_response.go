package worker

import (
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func workerRuntimeConfigurationResponse(configuration *model.WorkerRuntimeConfiguration) *api.WorkerRuntimeConfiguration {
	if configuration == nil {
		return nil
	}
	result := &api.WorkerRuntimeConfiguration{SchemaVersion: configuration.SchemaVersion, Native: workerRuntimeNativeResponse(configuration.Native), Projects: make([]api.WorkerRuntimeProject, 0, len(configuration.Projects))}
	for _, project := range configuration.Projects {
		result.Projects = append(result.Projects, api.WorkerRuntimeProject{ProjectID: project.ProjectID, Native: workerRuntimeNativeResponse(project.Native)})
	}
	return result
}

func workerRuntimeNativeResponse(native *model.WorkerRuntimeNative) *api.WorkerRuntimeNative {
	if native == nil {
		return nil
	}
	return &api.WorkerRuntimeNative{Agent: string(native.Agent), Model: api.WorkerConfigurationValue(native.Model), ReasoningEffort: api.WorkerConfigurationValue(native.ReasoningEffort)}
}
