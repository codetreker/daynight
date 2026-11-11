package worker

import (
	"time"
)

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

type WorkerAssistantProvider struct {
	Provider  string   `json:"provider"`
	Available bool     `json:"available"`
	Reason    *string  `json:"reason"`
	Model     *string  `json:"model"`
	Args      []string `json:"args"`
}

type WorkerAssistantHost struct {
	CreationConfigurationVersion int                       `json:"creationConfigurationVersion,omitempty"`
	ProtocolVersion              int64                     `json:"protocolVersion"`
	ObservedAt                   time.Time                 `json:"observedAt"`
	DefaultCwd                   string                    `json:"defaultCwd"`
	DefaultProvider              string                    `json:"defaultProvider"`
	Providers                    []WorkerAssistantProvider `json:"providers"`
}

type WorkerTelemetry struct {
	ToolPaths            *ToolPathTelemetry          `json:"toolPaths,omitempty"`
	RuntimeConfiguration *WorkerRuntimeConfiguration `json:"runtimeConfiguration,omitempty"`
	AssistantHost        *WorkerAssistantHost        `json:"assistantHost,omitempty"`
	Machine              WorkerMachine               `json:"machine"`
	Platform             string                      `json:"platform"`
	WorkingDirectory     string                      `json:"workingDirectory"`
	SampledAt            time.Time                   `json:"sampledAt"`
	OS                   WorkerProbe[WorkerOS]       `json:"os"`
	CPU                  WorkerProbe[WorkerCPU]      `json:"cpu"`
	Memory               WorkerProbe[WorkerMemory]   `json:"memory"`
	Disk                 WorkerProbe[WorkerDisk]     `json:"disk"`
	Versions             WorkerVersions              `json:"versions"`
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
	WorkerTelemetry
	TaskInventory *WorkerTaskInventory `json:"taskInventory"`
}

type WorkerReportResponse struct {
	ObservedAt     time.Time `json:"observedAt"`
	LastReportedAt time.Time `json:"lastReportedAt"`
}

type WorkerTaskSnapshot struct {
	ProjectID   string `json:"projectId"`
	TaskID      string `json:"taskId"`
	ClaimID     string `json:"claimId"`
	Title       string `json:"title"`
	ProjectName string `json:"projectName"`
	Status      string `json:"status"`
	Phase       string `json:"phase"`
	Agent       string `json:"agent"`
}

type WorkerSummary struct {
	WorkerID             string        `json:"workerId"`
	Machine              WorkerMachine `json:"machine"`
	Platform             string        `json:"platform"`
	LastReportedAt       time.Time     `json:"lastReportedAt"`
	TaskObservationState string        `json:"taskObservationState"`
	TaskObservedAt       *time.Time    `json:"taskObservedAt"`
	ActiveTaskCount      *int          `json:"activeTaskCount"`
}

type WorkerDetail struct {
	WorkerSummary
	Telemetry           WorkerTelemetry      `json:"telemetry"`
	InventoryObservedAt *time.Time           `json:"inventoryObservedAt"`
	Tasks               []WorkerTaskSnapshot `json:"tasks"`
}

type WorkerPage struct {
	ObservedAt time.Time       `json:"observedAt"`
	Items      []WorkerSummary `json:"items"`
	NextCursor *string         `json:"nextCursor"`
}

type WorkerDetailResponse struct {
	ObservedAt time.Time    `json:"observedAt"`
	Worker     WorkerDetail `json:"worker"`
}
