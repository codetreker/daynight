package core

import "time"

type WorkerProbe[T any] struct {
	State     string    `json:"state"`
	CheckedAt time.Time `json:"checkedAt"`
	Value     *T        `json:"value,omitempty"`
	Code      *string   `json:"code,omitempty"`
}

type WorkerOS struct {
	Type    string `json:"type"`
	Release string `json:"release"`
	Version string `json:"version"`
	Arch    string `json:"arch"`
}

type WorkerCPU struct {
	Model             string  `json:"model"`
	LogicalProcessors int64   `json:"logicalProcessors"`
	UsagePercent      float64 `json:"usagePercent"`
}

type WorkerMemory struct {
	UsedBytes  int64 `json:"usedBytes"`
	TotalBytes int64 `json:"totalBytes"`
}

type WorkerDisk struct {
	AvailableBytes int64 `json:"availableBytes"`
	TotalBytes     int64 `json:"totalBytes"`
}

type WorkerVersions struct {
	Daynight string              `json:"daynight"`
	Herdr    WorkerProbe[string] `json:"herdr"`
	Codex    WorkerProbe[string] `json:"codex"`
	Copilot  WorkerProbe[string] `json:"copilot"`
}

type WorkerTelemetry struct {
	Machine          WorkerMachine             `json:"machine"`
	Platform         TaskPlatform              `json:"platform"`
	WorkingDirectory string                    `json:"workingDirectory"`
	SampledAt        time.Time                 `json:"sampledAt"`
	OS               WorkerProbe[WorkerOS]     `json:"os"`
	CPU              WorkerProbe[WorkerCPU]    `json:"cpu"`
	Memory           WorkerProbe[WorkerMemory] `json:"memory"`
	Disk             WorkerProbe[WorkerDisk]   `json:"disk"`
	Versions         WorkerVersions            `json:"versions"`
}

type WorkerTaskReference struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	ClaimID   string `json:"claimId"`
}

type WorkerTaskInventory struct {
	ObservedAt time.Time             `json:"observedAt"`
	Claims     []WorkerTaskReference `json:"claims"`
}

type WorkerReport struct {
	Telemetry     WorkerTelemetry
	TaskInventory *WorkerTaskInventory
}

type WorkerTaskObservationState string

const (
	WorkerTasksObserved    WorkerTaskObservationState = "observed"
	WorkerTasksStale       WorkerTaskObservationState = "stale"
	WorkerTasksUnavailable WorkerTaskObservationState = "unavailable"
)

type WorkerObservedTask struct {
	ProjectID   string      `json:"projectId"`
	TaskID      string      `json:"taskId"`
	ClaimID     string      `json:"claimId"`
	Title       string      `json:"title"`
	ProjectName string      `json:"projectName"`
	Status      TaskStatus  `json:"status"`
	Phase       WorkerPhase `json:"phase"`
	Agent       WorkerAgent `json:"agent"`
}

type WorkerTaskObservation struct {
	State               WorkerTaskObservationState `json:"state"`
	ObservedAt          *time.Time                 `json:"observedAt"`
	InventoryObservedAt *time.Time                 `json:"inventoryObservedAt"`
	Items               []WorkerObservedTask       `json:"items"`
}

type WorkerSnapshot struct {
	UserID         string
	WorkerID       string
	CreatedAt      time.Time
	LastReportedAt time.Time
	Telemetry      WorkerTelemetry
	TaskSnapshot   WorkerTaskObservation
}
