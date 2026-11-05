package server

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

var workerReportTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$`)

var workerRequiredReportFields = []string{"machine", "platform", "workingDirectory", "sampledAt", "os", "cpu", "memory", "disk", "versions", "taskInventory"}

var workerReportFields = append(append([]string{}, workerRequiredReportFields...), "assistantHost")

func workerReportInput(fields map[string]json.RawMessage) (model.WorkerReport, error) {
	var input model.WorkerReport
	for _, key := range workerRequiredReportFields {
		if _, present := fields[key]; !present {
			return input, httpx.InvalidInput(key + " is required")
		}
	}
	var err error
	input.Telemetry.Machine, err = workerMachineInput(fields["machine"])
	if err != nil {
		return input, err
	}
	platform, err := httpx.RequiredString(fields, "platform")
	if err != nil {
		return input, err
	}
	input.Telemetry.Platform = model.TaskPlatform(platform)
	input.Telemetry.WorkingDirectory, err = httpx.RequiredString(fields, "workingDirectory")
	if err != nil {
		return input, err
	}
	input.Telemetry.SampledAt, err = workerTimeInput(fields, "sampledAt")
	if err != nil {
		return input, err
	}
	input.Telemetry.OS, err = workerProbeInput(fields["os"], "os", "", workerOSInput)
	if err != nil {
		return input, err
	}
	input.Telemetry.CPU, err = workerProbeInput(fields["cpu"], "cpu", "", workerCPUInput)
	if err != nil {
		return input, err
	}
	input.Telemetry.Memory, err = workerProbeInput(fields["memory"], "memory", "", workerMemoryInput)
	if err != nil {
		return input, err
	}
	input.Telemetry.Disk, err = workerProbeInput(fields["disk"], "disk", "", workerDiskInput)
	if err != nil {
		return input, err
	}
	versions, err := workerObject(fields["versions"], "versions", "daynight", "herdr", "codex", "copilot")
	if err != nil {
		return input, err
	}
	input.Telemetry.Versions.Daynight, err = httpx.RequiredString(versions, "daynight")
	if err != nil {
		return input, err
	}
	input.Telemetry.Versions.Herdr, err = workerProbeInput(versions["herdr"], "herdr", "not_running", workerVersionInput)
	if err != nil {
		return input, err
	}
	input.Telemetry.Versions.Codex, err = workerProbeInput(versions["codex"], "codex", "not_installed", workerVersionInput)
	if err != nil {
		return input, err
	}
	input.Telemetry.Versions.Copilot, err = workerProbeInput(versions["copilot"], "copilot", "not_installed", workerVersionInput)
	if err != nil {
		return input, err
	}
	if raw, present := fields["assistantHost"]; present {
		input.Telemetry.AssistantHost, err = workerAssistantHostInput(raw)
		if err != nil {
			return input, err
		}
	}
	input.TaskInventory, err = workerInventoryInput(fields["taskInventory"])
	return input, err
}

func workerObject(raw json.RawMessage, path string, keys ...string) (map[string]json.RawMessage, error) {
	fields, err := jsonobject.Decode(raw, path, keys...)
	if err != nil {
		return nil, httpx.InvalidInput(err.Error())
	}
	for _, key := range keys {
		if _, exists := fields[key]; !exists {
			return nil, httpx.InvalidInput(path + "." + key + " is required")
		}
	}
	return fields, nil
}

func workerTimeInput(fields map[string]json.RawMessage, key string) (time.Time, error) {
	value, err := httpx.RequiredString(fields, key)
	if err != nil {
		return time.Time{}, err
	}
	if !workerReportTimestamp.MatchString(value) {
		return time.Time{}, httpx.InvalidInput(key + " must be an RFC3339 timestamp")
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.ToUpper(value))
	if err != nil {
		return time.Time{}, httpx.InvalidInput(key + " must be an RFC3339 timestamp")
	}
	return parsed.UTC(), nil
}

func workerProbeInput[T any](raw json.RawMessage, path, special string, valueInput func(json.RawMessage) (T, error)) (model.WorkerProbe[T], error) {
	var probe model.WorkerProbe[T]
	fields, err := jsonobject.Decode(raw, path, "state", "checkedAt", "value", "code")
	if err != nil {
		return probe, httpx.InvalidInput(err.Error())
	}
	probe.State, err = httpx.RequiredString(fields, "state")
	if err != nil {
		return probe, err
	}
	allowed := []string{"state", "checkedAt"}
	switch probe.State {
	case "ok":
		allowed = append(allowed, "value")
	case "error":
		allowed = append(allowed, "code")
	default:
		if special == "" || probe.State != special {
			return probe, httpx.InvalidInput(path + " has an invalid probe state")
		}
	}
	fields, err = workerObject(raw, path, allowed...)
	if err != nil {
		return probe, err
	}
	probe.CheckedAt, err = workerTimeInput(fields, "checkedAt")
	if err != nil {
		return probe, err
	}
	if probe.State == "ok" {
		value, err := valueInput(fields["value"])
		if err != nil {
			return probe, err
		}
		probe.Value = &value
	}
	if probe.State == "error" {
		code, err := httpx.RequiredString(fields, "code")
		if err != nil {
			return probe, err
		}
		probe.Code = &code
	}
	return probe, nil
}

func workerVersionInput(raw json.RawMessage) (string, error) {
	return httpx.RequiredString(map[string]json.RawMessage{"version": raw}, "version")
}

func workerOSInput(raw json.RawMessage) (model.WorkerOS, error) {
	fields, err := workerObject(raw, "os.value", "type", "release", "version", "arch")
	if err != nil {
		return model.WorkerOS{}, err
	}
	var value model.WorkerOS
	for key, field := range map[string]*string{"type": &value.Type, "release": &value.Release, "version": &value.Version, "arch": &value.Arch} {
		*field, err = httpx.RequiredString(fields, key)
		if err != nil {
			return value, err
		}
	}
	return value, nil
}

func workerCPUInput(raw json.RawMessage) (model.WorkerCPU, error) {
	fields, err := workerObject(raw, "cpu.value", "model", "logicalProcessors", "usagePercent")
	if err != nil {
		return model.WorkerCPU{}, err
	}
	var value model.WorkerCPU
	value.Model, err = httpx.RequiredString(fields, "model")
	if err != nil {
		return value, err
	}
	value.LogicalProcessors, err = workerIntegerInput(fields["logicalProcessors"])
	if err != nil {
		return value, err
	}
	if bytes.Equal(bytes.TrimSpace(fields["usagePercent"]), []byte("null")) || json.Unmarshal(fields["usagePercent"], &value.UsagePercent) != nil || math.IsNaN(value.UsagePercent) || math.IsInf(value.UsagePercent, 0) {
		return value, httpx.InvalidInput("usagePercent must be a finite number")
	}
	return value, nil
}

func workerMemoryInput(raw json.RawMessage) (model.WorkerMemory, error) {
	fields, err := workerObject(raw, "memory.value", "usedBytes", "totalBytes")
	if err != nil {
		return model.WorkerMemory{}, err
	}
	used, err := workerIntegerInput(fields["usedBytes"])
	if err != nil {
		return model.WorkerMemory{}, err
	}
	total, err := workerIntegerInput(fields["totalBytes"])
	return model.WorkerMemory{UsedBytes: used, TotalBytes: total}, err
}

func workerDiskInput(raw json.RawMessage) (model.WorkerDisk, error) {
	fields, err := workerObject(raw, "disk.value", "availableBytes", "totalBytes")
	if err != nil {
		return model.WorkerDisk{}, err
	}
	available, err := workerIntegerInput(fields["availableBytes"])
	if err != nil {
		return model.WorkerDisk{}, err
	}
	total, err := workerIntegerInput(fields["totalBytes"])
	return model.WorkerDisk{AvailableBytes: available, TotalBytes: total}, err
}

func workerIntegerInput(raw json.RawMessage) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var parsed any
	if decoder.Decode(&parsed) != nil {
		return 0, httpx.InvalidInput("resource counts must be nonnegative safe integers")
	}
	number, ok := parsed.(json.Number)
	if !ok {
		return 0, httpx.InvalidInput("resource counts must be nonnegative safe integers")
	}
	text := number.String()
	negative := strings.HasPrefix(text, "-")
	text = strings.TrimPrefix(text, "-")
	mantissa, exponent, hasExponent := strings.Cut(strings.ToLower(text), "e")
	integer, fraction, _ := strings.Cut(mantissa, ".")
	digits := strings.TrimLeft(integer+fraction, "0")
	if digits == "" {
		return 0, nil
	}
	if negative {
		return 0, httpx.InvalidInput("resource counts must be nonnegative safe integers")
	}
	power := 0
	if hasExponent {
		value, err := strconv.Atoi(exponent)
		if err != nil || value > len(fraction)+16 || value < -len(digits) {
			return 0, httpx.InvalidInput("resource counts must be nonnegative safe integers")
		}
		power = value
	}
	power -= len(fraction)
	if power < 0 {
		if power < -len(digits) || len(digits)-len(strings.TrimRight(digits, "0")) < -power {
			return 0, httpx.InvalidInput("resource counts must be nonnegative safe integers")
		}
		digits = digits[:len(digits)+power]
	} else {
		if len(digits)+power > 16 {
			return 0, httpx.InvalidInput("resource counts must be nonnegative safe integers")
		}
		digits += strings.Repeat("0", power)
	}
	value, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || value > 1<<53-1 {
		return 0, httpx.InvalidInput("resource counts must be nonnegative safe integers")
	}
	return value, nil
}

func workerInventoryInput(raw json.RawMessage) (*model.WorkerTaskInventory, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	fields, err := workerObject(raw, "taskInventory", "observedAt", "claims")
	if err != nil {
		return nil, err
	}
	observedAt, err := workerTimeInput(fields, "observedAt")
	if err != nil {
		return nil, err
	}
	if bytes.Equal(bytes.TrimSpace(fields["claims"]), []byte("null")) {
		return nil, httpx.InvalidInput("claims must be an array")
	}
	var claims []json.RawMessage
	if json.Unmarshal(fields["claims"], &claims) != nil {
		return nil, httpx.InvalidInput("claims must be an array")
	}
	inventory := &model.WorkerTaskInventory{ObservedAt: observedAt, Claims: make([]model.WorkerTaskReference, 0, len(claims))}
	for _, raw := range claims {
		values, err := workerObject(raw, "taskInventory.claims", "projectId", "taskId", "claimId")
		if err != nil {
			return nil, err
		}
		var reference model.WorkerTaskReference
		for key, field := range map[string]*string{"projectId": &reference.ProjectID, "taskId": &reference.TaskID, "claimId": &reference.ClaimID} {
			*field, err = httpx.RequiredString(values, key)
			if err != nil {
				return nil, err
			}
		}
		inventory.Claims = append(inventory.Claims, reference)
	}
	return inventory, nil
}
