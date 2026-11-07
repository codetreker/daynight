package worker

type WorkerConfigurationValue struct {
	Value  *string `json:"value"`
	Source string  `json:"source"`
}

type WorkerRuntimeNative struct {
	Agent           string                   `json:"agent"`
	Model           WorkerConfigurationValue `json:"model"`
	ReasoningEffort WorkerConfigurationValue `json:"reasoningEffort"`
}

type WorkerRuntimeProject struct {
	ProjectID string               `json:"projectId"`
	Native    *WorkerRuntimeNative `json:"native"`
}

type WorkerRuntimeConfiguration struct {
	SchemaVersion int64                  `json:"schemaVersion"`
	Native        *WorkerRuntimeNative   `json:"native"`
	Projects      []WorkerRuntimeProject `json:"projects"`
}
