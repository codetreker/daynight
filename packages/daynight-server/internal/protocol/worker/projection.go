package worker

import (
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

func Summary(worker model.WorkerSnapshot) WorkerSummary {
	var count *int
	if worker.TaskSnapshot.State != model.WorkerTasksUnavailable {
		n := len(worker.TaskSnapshot.Items)
		count = &n
	}
	return WorkerSummary{WorkerID: worker.WorkerID,
		Machine: WorkerMachine{ID: worker.Telemetry.Machine.ID, Name: worker.Telemetry.Machine.Name}, Platform: string(worker.Telemetry.Platform),
		LastReportedAt: worker.LastReportedAt.UTC(), TaskObservationState: string(worker.TaskSnapshot.State),
		TaskObservedAt: optionalTime(worker.TaskSnapshot.ObservedAt), ActiveTaskCount: count}
}

func Detail(worker model.WorkerSnapshot) WorkerDetail {
	telemetry := worker.Telemetry
	response := WorkerDetail{WorkerSummary: Summary(worker), InventoryObservedAt: optionalTime(worker.TaskSnapshot.InventoryObservedAt), Tasks: make([]WorkerTaskSnapshot, 0, len(worker.TaskSnapshot.Items)),
		Telemetry: WorkerTelemetry{Machine: WorkerMachine{ID: telemetry.Machine.ID, Name: telemetry.Machine.Name}, Platform: string(telemetry.Platform),
			WorkingDirectory: telemetry.WorkingDirectory, SampledAt: telemetry.SampledAt.UTC(), AssistantHost: assistantHostResponse(telemetry.AssistantHost), RuntimeConfiguration: RuntimeConfiguration(telemetry.RuntimeConfiguration),
			OS:     probeResponse(telemetry.OS, func(value model.WorkerOS) WorkerOS { return WorkerOS(value) }),
			CPU:    probeResponse(telemetry.CPU, func(value model.WorkerCPU) WorkerCPU { return WorkerCPU(value) }),
			Memory: probeResponse(telemetry.Memory, func(value model.WorkerMemory) WorkerMemory { return WorkerMemory(value) }),
			Disk:   probeResponse(telemetry.Disk, func(value model.WorkerDisk) WorkerDisk { return WorkerDisk(value) }),
			Versions: WorkerVersions{Daynight: telemetry.Versions.Daynight,
				Herdr:   probeResponse(telemetry.Versions.Herdr, func(value string) string { return value }),
				Codex:   probeResponse(telemetry.Versions.Codex, func(value string) string { return value }),
				Copilot: probeResponse(telemetry.Versions.Copilot, func(value string) string { return value })}}}

	for _, task := range worker.TaskSnapshot.Items {
		response.Tasks = append(response.Tasks, WorkerTaskSnapshot{ProjectID: task.ProjectID, TaskID: task.TaskID, ClaimID: task.ClaimID, Title: task.Title, ProjectName: task.ProjectName, Status: string(task.Status), Phase: string(task.Phase), Agent: string(task.Agent)})
	}
	return response
}

func probeResponse[S, T any](probe model.WorkerProbe[S], convert func(S) T) WorkerProbe[T] {
	response := WorkerProbe[T]{State: probe.State, CheckedAt: probe.CheckedAt.UTC(), Code: probe.Code}
	if probe.Value != nil {
		value := convert(*probe.Value)
		response.Value = &value
	}
	return response
}

func optionalTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

func assistantHostResponse(host *model.WorkerAssistantHost) *WorkerAssistantHost {
	if host == nil {
		return nil
	}
	response := &WorkerAssistantHost{CreationConfigurationVersion: host.CreationConfigurationVersion, ProtocolVersion: host.ProtocolVersion, ObservedAt: host.ObservedAt.UTC(), DefaultCwd: host.DefaultCwd, DefaultProvider: string(host.DefaultProvider), Providers: make([]WorkerAssistantProvider, 0, len(host.Providers))}
	for _, provider := range host.Providers {
		response.Providers = append(response.Providers, WorkerAssistantProvider{Provider: string(provider.Provider), Available: provider.Available, Reason: provider.Reason, Model: provider.Model, Args: provider.Args})
	}
	return response
}

func RuntimeConfiguration(configuration *model.WorkerRuntimeConfiguration) *WorkerRuntimeConfiguration {
	if configuration == nil {
		return nil
	}
	result := &WorkerRuntimeConfiguration{SchemaVersion: configuration.SchemaVersion, Native: runtimeNativeResponse(configuration.Native), Projects: make([]WorkerRuntimeProject, 0, len(configuration.Projects))}
	for _, project := range configuration.Projects {
		result.Projects = append(result.Projects, WorkerRuntimeProject{ProjectID: project.ProjectID, Native: runtimeNativeResponse(project.Native)})
	}
	return result
}

func runtimeNativeResponse(native *model.WorkerRuntimeNative) *WorkerRuntimeNative {
	if native == nil {
		return nil
	}
	return &WorkerRuntimeNative{Agent: string(native.Agent), Model: WorkerConfigurationValue(native.Model), ReasoningEffort: WorkerConfigurationValue(native.ReasoningEffort)}
}

// EncodeItem measures the Worker item without the outer response envelope.
func EncodeItem(w io.Writer, snapshot model.WorkerSnapshot, max int64) (int64, error) {
	if err := preflightCollections(snapshot, max); err != nil {
		return 0, err
	}
	return measure.JSON(w, "worker", max, Detail(snapshot), false)
}

// EncodeTelemetry and the configuration encoders use the exact JSON shapes
// stored by the Worker DAO; those values do not carry a terminal newline.
func EncodeTelemetry(w io.Writer, value model.WorkerTelemetry, max int64) (int64, error) {
	return measure.JSON(w, "worker.telemetry", max, model.WorkerTelemetryWire(value), false)
}
func EncodeConfiguration(w io.Writer, value model.WorkerConfiguration, max int64) (int64, error) {
	return measure.JSON(w, "worker.configuration", max, model.WorkerConfigurationWire(value), false)
}
func EncodeObservation(w io.Writer, value model.WorkerConfigurationReportedObservation, max int64) (int64, error) {
	return measure.JSON(w, "worker.configuration.observation", max, model.WorkerConfigurationReportedObservationWire(value), false)
}

// Write admission counts collections before allocating their protocol projection.
// Each collection must fit within the complete stored Worker item budget.
func preflightCollections(snapshot model.WorkerSnapshot, max int64) error {
	if _, err := measure.JSON(io.Discard, "worker", max, snapshot.TaskSnapshot.Items, false); err != nil {
		return err
	}
	if host := snapshot.Telemetry.AssistantHost; host != nil {
		if _, err := measure.JSON(io.Discard, "worker", max, host.Providers, false); err != nil {
			return err
		}
	}
	if config := snapshot.Telemetry.RuntimeConfiguration; config != nil {
		if _, err := measure.JSON(io.Discard, "worker", max, config.Projects, false); err != nil {
			return err
		}
	}
	return nil
}
