package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"strings"
	"testing"
)

func TestSudoCleanupProtocolOmission(t *testing.T) {
	document := configurationInputDocument()
	for _, entry := range []struct {
		value                      any
		present, preserve, enabled bool
	}{
		{nil, false, true, false}, {false, true, false, false}, {true, true, false, true},
	} {
		if entry.present {
			document["enableSudoCleanup"] = entry.value
		} else {
			delete(document, "enableSudoCleanup")
		}
		value, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{})
		if err != nil || value.PreserveSudoCleanup != entry.preserve || value.EnableSudoCleanup != entry.enabled {
			t.Fatalf("protocol value %v: %+v %v", entry.value, value, err)
		}
		normalized, err := NormalizeConfiguration(value)
		if err != nil || normalized.PreserveSudoCleanup != entry.preserve {
			t.Fatalf("normalization lost omission: %+v %v", normalized, err)
		}
	}
	for _, invalid := range []any{nil, "false", 1} {
		document["enableSudoCleanup"] = invalid
		if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{}); err == nil {
			t.Fatalf("accepted %v", invalid)
		}
	}
}

func TestWindowsProcessCleanupProtocolOmission(t *testing.T) {
	document := configurationInputDocument()
	for _, entry := range []struct {
		value                      any
		present, preserve, enabled bool
	}{
		{nil, false, true, false}, {false, true, false, false}, {true, true, false, true},
	} {
		if entry.present {
			document["enableWindowsProcessCleanup"] = entry.value
		} else {
			delete(document, "enableWindowsProcessCleanup")
		}
		value, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{})
		if err != nil || value.PreserveWindowsProcessCleanup != entry.preserve || value.EnableWindowsProcessCleanup != entry.enabled {
			t.Fatalf("protocol value %v: %+v %v", entry.value, value, err)
		}
		normalized, err := NormalizeConfiguration(value)
		if err != nil || normalized.PreserveWindowsProcessCleanup != entry.preserve {
			t.Fatalf("normalization lost omission: %+v %v", normalized, err)
		}
	}
	for _, invalid := range []any{nil, "false", 1} {
		document["enableWindowsProcessCleanup"] = invalid
		if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{}); err == nil {
			t.Fatalf("accepted %v", invalid)
		}
	}
}

func TestConfigurationMergeChecksFinalEncodedBudget(t *testing.T) {
	value := configurationFixture()
	args := make([][]string, 8)
	for i := range args {
		args[i] = make([]string, MaxNativeArgs)
		for j := range args[i] {
			args[i][j] = strings.Repeat("x", MaxNativeArgBytes)
		}
		raw, _ := json.Marshal(args[i])
		value.Projects = append(value.Projects, model.WorkerProjectConfiguration{ProjectID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1), NativeOverrides: map[string]json.RawMessage{"args": raw}})
	}
	encoded, _ := json.Marshal(value)
	excess := len(encoded) - MaxConfigurationJSONBytes
	if excess <= 0 {
		t.Fatal("fixture did not reach configuration budget")
	}
	for i := len(args) - 1; i >= 0 && excess > 0; i-- {
		for j := len(args[i]) - 1; j >= 0 && excess > 0; j-- {
			remove := min(excess, len(args[i][j])-1)
			args[i][j] = args[i][j][:len(args[i][j])-remove]
			excess -= remove
		}
		raw, _ := json.Marshal(args[i])
		value.Projects[i].NativeOverrides["args"] = raw
	}
	encoded, _ = json.Marshal(value)
	if len(encoded) != MaxConfigurationJSONBytes {
		t.Fatalf("fixture size: %d", len(encoded))
	}
	if _, err := NormalizeConfiguration(value); err != nil {
		t.Fatalf("boundary configuration rejected: %v", err)
	}
	ctx, principal := context.Background(), model.Principal{UserID: "user"}
	legacy := value
	legacy.ArchiveSessions = nil
	legacy.PreserveArchiveSessions = true
	legacy.MaxConcurrent = 2
	dao := configuredDAO("1")
	dao.current.Desired.Value = value
	result, err := PutConfiguration(ctx, dao, principal, "worker", 1, legacy)
	if err != nil || result.Desired.Revision != "2" || result.Desired.Value.ArchiveSessions == nil || !*result.Desired.Value.ArchiveSessions {
		t.Fatalf("boundary legacy replacement: %+v %v", result, err)
	}
	bootstrap := value
	bootstrap.ArchiveSessions = nil
	dao = &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}}
	receipt, err := ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &bootstrap})
	if err != nil || receipt.Desired.Value.ArchiveSessions == nil || !*receipt.Desired.Value.ArchiveSessions {
		t.Fatalf("boundary bootstrap: %+v %v", receipt, err)
	}
}
