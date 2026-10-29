package service

import (
	"math"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

const workerSafeInteger = int64(1<<53 - 1)

var workerProbeCodes = []string{"not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "invalid_sample", "out_of_range", "io_error", "unavailable"}

func validateWorkerReport(input core.WorkerReport) (core.WorkerReport, error) {
	telemetry := &input.Telemetry
	machineID, err := CanonicalID(telemetry.Machine.ID)
	if err != nil {
		return core.WorkerReport{}, err
	}
	telemetry.Machine.ID = machineID
	if !workerText(telemetry.Machine.Name) || !workerText(telemetry.WorkingDirectory) || !workerText(telemetry.Versions.Daynight) {
		return core.WorkerReport{}, invalidInput("Worker machine name, working directory and Daynight version must be nonempty UTF-8 text without NUL.")
	}
	if !telemetry.Platform.Valid() || !workerReportTime(telemetry.SampledAt) {
		return core.WorkerReport{}, invalidInput("Worker platform and sample time are invalid.")
	}
	checks := []error{
		validateWorkerProbe(telemetry.OS, "", func(value core.WorkerOS) bool {
			return workerText(value.Type) && workerText(value.Release) && workerText(value.Version) && workerText(value.Arch)
		}),
		validateWorkerProbe(telemetry.CPU, "", func(value core.WorkerCPU) bool {
			return workerText(value.Model) && value.LogicalProcessors > 0 && value.LogicalProcessors <= workerSafeInteger && !math.IsNaN(value.UsagePercent) && !math.IsInf(value.UsagePercent, 0) && value.UsagePercent >= 0 && value.UsagePercent <= 100
		}),
		validateWorkerProbe(telemetry.Memory, "", func(value core.WorkerMemory) bool {
			return workerBytes(value.UsedBytes) && workerBytes(value.TotalBytes) && value.UsedBytes <= value.TotalBytes
		}),
		validateWorkerProbe(telemetry.Disk, "", func(value core.WorkerDisk) bool {
			return workerBytes(value.AvailableBytes) && workerBytes(value.TotalBytes) && value.AvailableBytes <= value.TotalBytes
		}),
		validateWorkerProbe(telemetry.Versions.Herdr, "not_running", workerText),
		validateWorkerProbe(telemetry.Versions.Codex, "not_installed", workerText),
		validateWorkerProbe(telemetry.Versions.Copilot, "not_installed", workerText),
	}
	for _, err := range checks {
		if err != nil {
			return core.WorkerReport{}, err
		}
	}
	if input.TaskInventory == nil {
		return input, nil
	}
	inventory := *input.TaskInventory
	if !workerReportTime(inventory.ObservedAt) || inventory.Claims == nil {
		return core.WorkerReport{}, invalidInput("Task inventory must contain an observation time and an explicit claims array.")
	}
	inventory.Claims = slices.Clone(inventory.Claims)
	seen := make(map[string]bool, len(inventory.Claims))
	for index, reference := range inventory.Claims {
		for _, destination := range []*string{&reference.ProjectID, &reference.TaskID, &reference.ClaimID} {
			id, err := CanonicalID(*destination)
			if err != nil {
				return core.WorkerReport{}, err
			}
			*destination = id
		}
		if seen[reference.TaskID] {
			return core.WorkerReport{}, invalidInput("Task inventory contains duplicate task references.")
		}
		seen[reference.TaskID] = true
		inventory.Claims[index] = reference
	}
	input.TaskInventory = &inventory
	return input, nil
}

func workerReportTime(value time.Time) bool {
	return !value.IsZero() && value.Year() >= 0 && value.Year() <= 9999
}

func workerBytes(value int64) bool { return value >= 0 && value <= workerSafeInteger }

func validateWorkerProbe[T any](probe core.WorkerProbe[T], special string, valid func(T) bool) error {
	if !workerReportTime(probe.CheckedAt) {
		return invalidInput("Probe checkedAt must be a valid observation time.")
	}
	switch probe.State {
	case "ok":
		if probe.Value == nil || probe.Code != nil || !valid(*probe.Value) {
			return invalidInput("Successful probe must contain a valid value and no error code.")
		}
	case "error":
		if probe.Value != nil || probe.Code == nil || !slices.Contains(workerProbeCodes, *probe.Code) {
			return invalidInput("Failed probe must contain an allowed error code and no value.")
		}
	default:
		if special == "" || probe.State != special || probe.Value != nil || probe.Code != nil {
			return invalidInput("Probe state or fields are invalid.")
		}
	}
	return nil
}
