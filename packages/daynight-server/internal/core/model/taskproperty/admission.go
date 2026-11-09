package taskproperty

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

const (
	MaxValueBytes                 = 8 * 1024
	MaxPullRequestURLBytes        = 2 * 1024
	MaxPullRequestTitleBytes      = 1024
	MaxWorkerMachineNameBytes     = 256
	MaxWorkerNativeSessionIDBytes = 256
	MaxWorkerHerdrFieldBytes      = 128
)

func checkBytes(field, value string, max int) error {
	if len(value) > max {
		return &limit.Violation{Field: field, Actual: int64(len(value)), Max: int64(max), Unit: "bytes"}
	}
	return nil
}

// AdmitValue checks the byte budgets of a value returned by NormalizeValue.
// Callers must normalize and handle structure errors first, and separately
// enforce write permissions. Oversized values are rejected before field decoding;
// violations never contain values. This policy applies equally to public and
// read-only properties, and does not modify the input.
func AdmitValue(name string, normalized json.RawMessage) error {
	if _, err := definition(name); err != nil {
		return err
	}
	if len(normalized) > MaxValueBytes {
		return &limit.Violation{Field: "properties." + name, Actual: int64(len(normalized)), Max: MaxValueBytes, Unit: "bytes"}
	}
	switch name {
	case "pullRequests":
		values, err := decodePullRequests(normalized)
		if err != nil {
			return err
		}
		for i, value := range values {
			if err := checkBytes(fmt.Sprintf("properties.pullRequests[%d].url", i), value.URL, MaxPullRequestURLBytes); err != nil {
				return err
			}
			if err := checkBytes(fmt.Sprintf("properties.pullRequests[%d].title", i), value.Title, MaxPullRequestTitleBytes); err != nil {
				return err
			}
		}
	case "worker":
		value, err := decodeWorker(normalized)
		if err != nil {
			return err
		}
		if err := checkBytes("properties.worker.machine.name", value.Machine.Name, MaxWorkerMachineNameBytes); err != nil {
			return err
		}
		if value.NativeSessionID != nil {
			if err := checkBytes("properties.worker.nativeSessionId", *value.NativeSessionID, MaxWorkerNativeSessionIDBytes); err != nil {
				return err
			}
		}
		if value.Herdr != nil {
			if err := checkBytes("properties.worker.herdr.session", value.Herdr.Session, MaxWorkerHerdrFieldBytes); err != nil {
				return err
			}
			if err := checkBytes("properties.worker.herdr.workspaceId", value.Herdr.WorkspaceID, MaxWorkerHerdrFieldBytes); err != nil {
				return err
			}
			if err := checkBytes("properties.worker.herdr.paneId", value.Herdr.PaneID, MaxWorkerHerdrFieldBytes); err != nil {
				return err
			}
		}
	}
	return nil
}

// Admit checks previously normalized properties independently in name order.
func Admit(properties model.TaskProperties) error {
	for _, name := range slices.Sorted(maps.Keys(properties)) {
		if err := AdmitValue(name, properties[name]); err != nil {
			return err
		}
	}
	return nil
}
