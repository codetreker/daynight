package api

import "time"

type TaskViewRecord struct {
	ID                string     `json:"id"`
	TitlePreview      string     `json:"titlePreview"`
	TitleTruncated    bool       `json:"titleTruncated"`
	Status            string     `json:"status"`
	Version           string     `json:"version"`
	DependsOn         []string   `json:"dependsOn"`
	ExternalDependsOn []string   `json:"externalDependsOn"`
	RequiredPlatform  *string    `json:"requiredPlatform"`
	AllowAgents       bool       `json:"allowAgents"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
	StartedAt         *time.Time `json:"startedAt"`
	CompletedAt       *time.Time `json:"completedAt"`
}

type TaskSync struct {
	Mode       string           `json:"mode"`
	Epoch      string           `json:"epoch"`
	Project    Project          `json:"project"`
	ObservedAt time.Time        `json:"observedAt"`
	Tasks      []TaskViewRecord `json:"tasks"`
}
