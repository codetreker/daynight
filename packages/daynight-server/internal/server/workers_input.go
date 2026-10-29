package server

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
)

var workerReportTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$`)

var workerReportFields = []string{"machine", "platform", "workingDirectory", "sampledAt", "os", "cpu", "memory", "disk", "versions", "taskInventory"}

func workerReportInput(fields map[string]json.RawMessage) (core.WorkerReport, error) {
	var input core.WorkerReport
	for _, key := range workerReportFields {
		if _, present := fields[key]; !present {
			return input, invalidInput(key + " is required")
		}
	}
	var err error
	input.Telemetry.Machine, err = workerMachineInput(fields["machine"])
	if err != nil {
		return input, err
	}
	platform, err := requiredString(fields, "platform")
	if err != nil {
		return input, err
	}
	input.Telemetry.Platform = core.TaskPlatform(platform)
	input.Telemetry.WorkingDirectory, err = requiredString(fields, "workingDirectory")
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
	input.Telemetry.Versions.Daynight, err = requiredString(versions, "daynight")
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
	input.TaskInventory, err = workerInventoryInput(fields["taskInventory"])
	return input, err
}

func workerObject(raw json.RawMessage, path string, keys ...string) (map[string]json.RawMessage, error) {
	fields, err := jsonobject.Decode(raw, path, keys...)
	if err != nil {
		return nil, invalidInput(err.Error())
	}
	for _, key := range keys {
		if _, exists := fields[key]; !exists {
			return nil, invalidInput(path + "." + key + " is required")
		}
	}
	return fields, nil
}

func workerTimeInput(fields map[string]json.RawMessage, key string) (time.Time, error) {
	value, err := requiredString(fields, key)
	if err != nil {
		return time.Time{}, err
	}
	if !workerReportTimestamp.MatchString(value) {
		return time.Time{}, invalidInput(key + " must be an RFC3339 timestamp")
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.ToUpper(value))
	if err != nil {
		return time.Time{}, invalidInput(key + " must be an RFC3339 timestamp")
	}
	return parsed.UTC(), nil
}

func workerProbeInput[T any](raw json.RawMessage, path, special string, valueInput func(json.RawMessage) (T, error)) (core.WorkerProbe[T], error) {
	var probe core.WorkerProbe[T]
	fields, err := jsonobject.Decode(raw, path, "state", "checkedAt", "value", "code")
	if err != nil {
		return probe, invalidInput(err.Error())
	}
	probe.State, err = requiredString(fields, "state")
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
			return probe, invalidInput(path + " has an invalid probe state")
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
		code, err := requiredString(fields, "code")
		if err != nil {
			return probe, err
		}
		probe.Code = &code
	}
	return probe, nil
}

func workerVersionInput(raw json.RawMessage) (string, error) {
	return requiredString(map[string]json.RawMessage{"version": raw}, "version")
}

func workerOSInput(raw json.RawMessage) (core.WorkerOS, error) {
	fields, err := workerObject(raw, "os.value", "type", "release", "version", "arch")
	if err != nil {
		return core.WorkerOS{}, err
	}
	var value core.WorkerOS
	for key, field := range map[string]*string{"type": &value.Type, "release": &value.Release, "version": &value.Version, "arch": &value.Arch} {
		*field, err = requiredString(fields, key)
		if err != nil {
			return value, err
		}
	}
	return value, nil
}

func workerCPUInput(raw json.RawMessage) (core.WorkerCPU, error) {
	fields, err := workerObject(raw, "cpu.value", "model", "logicalProcessors", "usagePercent")
	if err != nil {
		return core.WorkerCPU{}, err
	}
	var value core.WorkerCPU
	value.Model, err = requiredString(fields, "model")
	if err != nil {
		return value, err
	}
	value.LogicalProcessors, err = workerIntegerInput(fields["logicalProcessors"])
	if err != nil {
		return value, err
	}
	if bytes.Equal(bytes.TrimSpace(fields["usagePercent"]), []byte("null")) || json.Unmarshal(fields["usagePercent"], &value.UsagePercent) != nil || math.IsNaN(value.UsagePercent) || math.IsInf(value.UsagePercent, 0) {
		return value, invalidInput("usagePercent must be a finite number")
	}
	return value, nil
}

func workerMemoryInput(raw json.RawMessage) (core.WorkerMemory, error) {
	fields, err := workerObject(raw, "memory.value", "usedBytes", "totalBytes")
	if err != nil {
		return core.WorkerMemory{}, err
	}
	used, err := workerIntegerInput(fields["usedBytes"])
	if err != nil {
		return core.WorkerMemory{}, err
	}
	total, err := workerIntegerInput(fields["totalBytes"])
	return core.WorkerMemory{UsedBytes: used, TotalBytes: total}, err
}

func workerDiskInput(raw json.RawMessage) (core.WorkerDisk, error) {
	fields, err := workerObject(raw, "disk.value", "availableBytes", "totalBytes")
	if err != nil {
		return core.WorkerDisk{}, err
	}
	available, err := workerIntegerInput(fields["availableBytes"])
	if err != nil {
		return core.WorkerDisk{}, err
	}
	total, err := workerIntegerInput(fields["totalBytes"])
	return core.WorkerDisk{AvailableBytes: available, TotalBytes: total}, err
}

func workerIntegerInput(raw json.RawMessage) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var parsed any
	if decoder.Decode(&parsed) != nil {
		return 0, invalidInput("resource counts must be nonnegative safe integers")
	}
	number, ok := parsed.(json.Number)
	if !ok {
		return 0, invalidInput("resource counts must be nonnegative safe integers")
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
		return 0, invalidInput("resource counts must be nonnegative safe integers")
	}
	power := 0
	if hasExponent {
		value, err := strconv.Atoi(exponent)
		if err != nil || value > len(fraction)+16 || value < -len(digits) {
			return 0, invalidInput("resource counts must be nonnegative safe integers")
		}
		power = value
	}
	power -= len(fraction)
	if power < 0 {
		if power < -len(digits) || len(digits)-len(strings.TrimRight(digits, "0")) < -power {
			return 0, invalidInput("resource counts must be nonnegative safe integers")
		}
		digits = digits[:len(digits)+power]
	} else {
		if len(digits)+power > 16 {
			return 0, invalidInput("resource counts must be nonnegative safe integers")
		}
		digits += strings.Repeat("0", power)
	}
	value, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || value > 1<<53-1 {
		return 0, invalidInput("resource counts must be nonnegative safe integers")
	}
	return value, nil
}

func workerInventoryInput(raw json.RawMessage) (*core.WorkerTaskInventory, error) {
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
		return nil, invalidInput("claims must be an array")
	}
	var claims []json.RawMessage
	if json.Unmarshal(fields["claims"], &claims) != nil {
		return nil, invalidInput("claims must be an array")
	}
	inventory := &core.WorkerTaskInventory{ObservedAt: observedAt, Claims: make([]core.WorkerTaskReference, 0, len(claims))}
	for _, raw := range claims {
		values, err := workerObject(raw, "taskInventory.claims", "projectId", "taskId", "claimId")
		if err != nil {
			return nil, err
		}
		var reference core.WorkerTaskReference
		for key, field := range map[string]*string{"projectId": &reference.ProjectID, "taskId": &reference.TaskID, "claimId": &reference.ClaimID} {
			*field, err = requiredString(values, key)
			if err != nil {
				return nil, err
			}
		}
		inventory.Claims = append(inventory.Claims, reference)
	}
	return inventory, nil
}
