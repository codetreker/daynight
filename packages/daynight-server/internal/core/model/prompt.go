package model

import "time"

type PromptScope string

const (
	PromptScopeUser    PromptScope = "user"
	PromptScopeProject PromptScope = "project"
	PromptScopeWorker  PromptScope = "worker"
)

type PromptKey struct {
	Scope     PromptScope `json:"scope"`
	ProjectID string      `json:"projectId,omitempty"`
}

type PromptSelector struct {
	Key           PromptKey `json:"key"`
	KnownRevision *string   `json:"knownRevision"`
}

type PromptResource struct {
	Scope     PromptScope `json:"scope"`
	ScopeID   string      `json:"scopeId"`
	Revision  string      `json:"revision"`
	Text      string      `json:"text"`
	UpdatedAt *time.Time  `json:"updatedAt"`
}

type PromptResult struct {
	Key      PromptKey       `json:"key"`
	Status   string          `json:"status"`
	Value    *PromptResource `json:"value,omitempty"`
	Revision string          `json:"revision,omitempty"`
	Error    string          `json:"error,omitempty"`
}
