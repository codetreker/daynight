package worker

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func TestLegacyPlatformConfigurationRejectsInvalidProtocolValues(t *testing.T) {
	for _, value := range []any{nil, "false", 1, []any{}, map[string]any{}} {
		t.Run("preference "+string(configurationInputJSON(t, value)), func(t *testing.T) {
			document := legacyConfigurationInputDocument()
			document["preferPlatformSpecificTasks"] = value
			_, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{})
			requireFault(t, err, "invalid_input")
		})
	}
	for name, modelJSON := range map[string]string{
		"invalid UTF-8":      "\"" + string([]byte{0xff}) + "\"",
		"unpaired surrogate": `"\ud800"`,
	} {
		t.Run(name, func(t *testing.T) {
			raw := configurationInputJSON(t, legacyConfigurationInputDocument())
			raw = json.RawMessage(strings.Replace(string(raw), `"model":null`, `"model":`+modelJSON, 1))
			_, err := ParseWorkerConfigurationProtocol(raw, workerprotocol.Capabilities{})
			requireFault(t, err, "invalid_input")
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Message != "Worker configuration must contain valid Unicode." {
				t.Fatalf("legacy conversion changed malformed Unicode before rejecting it: %v", err)
			}
		})
	}
	document := legacyConfigurationInputDocument()
	document["native"].(map[string]any)["model"] = "\ufffd"
	parsed, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{})
	if err != nil || parsed.Native.Model == nil || *parsed.Native.Model != "\ufffd" {
		t.Fatalf("valid replacement character was changed or rejected: %+v %v", parsed, err)
	}
	document["maxConcurrent"] = 0
	_, err = ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" || fault.Message != "Worker configuration integer is outside its allowed range." {
		t.Fatalf("legacy conversion did not retain the configuration validation error: %v", err)
	}
}

func TestPlatformTaskModeProtocolAndBootstrap(t *testing.T) {
	for _, mode := range []string{"all", "prefer", "only"} {
		document := configurationInputDocument()
		document["platformTaskMode"] = mode
		parsed, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{PlatformTaskMode: true})
		if err != nil || string(parsed.PlatformTaskMode) != mode || parsed.LegacyPlatformTaskMode {
			t.Fatalf("enum %s: %+v %v", mode, parsed, err)
		}
		if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{}); err == nil {
			t.Fatal("enum accepted without capability")
		}
	}
	for _, prefer := range []bool{false, true} {
		document := legacyConfigurationInputDocument()
		document["preferPlatformSpecificTasks"] = prefer
		parsed, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{})
		if err != nil || !parsed.LegacyPlatformTaskMode || (parsed.PlatformTaskMode == model.PlatformTaskPrefer) != prefer {
			t.Fatalf("legacy: %+v %v", parsed, err)
		}
		exchange := map[string]any{"bootstrap": document, "observation": nil}
		for _, aware := range []bool{false, true} {
			got, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, exchange), workerprotocol.Capabilities{PlatformTaskMode: aware})
			if err != nil || got.Bootstrap.PlatformTaskMode != parsed.PlatformTaskMode {
				t.Fatalf("bootstrap aware=%v: %+v %v", aware, got, err)
			}
		}
	}
	for _, mode := range []any{nil, "", "invalid", false} {
		document := configurationInputDocument()
		document["platformTaskMode"] = mode
		if _, err := ParseWorkerConfiguration(configurationInputJSON(t, document)); err == nil {
			t.Fatalf("invalid mode accepted: %v", mode)
		}
	}
	for _, mode := range []string{"all", "prefer", "only"} {
		document := configurationInputDocument()
		document["platformTaskMode"] = mode
		if _, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, map[string]any{"bootstrap": document, "observation": nil}), workerprotocol.Capabilities{PlatformTaskMode: true}); err == nil {
			t.Fatal("bootstrap accepted enum")
		}
	}
	for _, applied := range []any{"all", "prefer", "only", nil} {
		item := configurationInputItem("platformTaskMode", applied)
		if applied == nil {
			item["state"] = "pending"
		}
		raw := configurationInputJSON(t, configurationInputExchange(item))
		if _, err := ParseWorkerConfigurationExchangeProtocol(raw, workerprotocol.Capabilities{PlatformTaskMode: true}); err != nil {
			t.Fatal(err)
		}
		if _, err := ParseWorkerConfigurationExchangeProtocol(raw, workerprotocol.Capabilities{}); err == nil {
			t.Fatal("enum observation accepted without capability")
		}
	}
	for _, applied := range []any{"invalid", false, 1} {
		if _, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, configurationInputExchange(configurationInputItem("platformTaskMode", applied)))); err == nil {
			t.Fatalf("invalid enum observation: %v", applied)
		}
	}
	only := configurationFixture()
	only.PlatformTaskMode = model.PlatformTaskOnly
	d := configuredDAO("7")
	if _, err := ExchangeConfiguration(t.Context(), d, model.Principal{UserID: "user"}, "worker", model.WorkerConfigurationExchange{Bootstrap: &only}); err == nil {
		t.Fatal("typed bootstrap enabled only")
	}
}

func TestPlatformTaskModeSupportAndLegacyCAS(t *testing.T) {
	principal := model.Principal{UserID: "user"}
	for _, kind := range []string{"", "preferPlatformSpecificTasks", "platformTaskMode"} {
		d := configuredDAO("7")
		if kind != "" {
			d.current.Observation = &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: kind}}}}}
		}
		value := configurationFixture()
		value.PlatformTaskMode = model.PlatformTaskOnly
		got, err := PutConfiguration(t.Context(), d, principal, "worker", 7, value)
		if kind == "platformTaskMode" {
			if err != nil || got.Desired.Value.PlatformTaskMode != model.PlatformTaskOnly || d.desiredWrites != 1 || got.Observation != d.current.Observation {
				t.Fatalf("supported: %+v %v", got, err)
			}
		} else {
			requireFault(t, err, "worker_platform_task_mode_unsupported")
			if d.desiredWrites != 0 {
				t.Fatal("unsupported mode was written")
			}
		}
	}
	for _, rawStored := range []bool{false, true} {
		for _, mode := range []model.WorkerPlatformTaskMode{model.PlatformTaskAll, model.PlatformTaskPrefer, model.PlatformTaskOnly} {
			d := configuredDAO("7")
			d.current.Desired.Value.PlatformTaskMode = model.PlatformTaskOnly
			if rawStored {
				raw, err := json.Marshal(d.current.Desired.Value)
				if err != nil {
					t.Fatal(err)
				}
				d.current.Desired.Raw = raw
				d.current.Desired.ArchiveSessions = new(true)
			}
			value := configurationFixture()
			value.PlatformTaskMode = mode
			value.LegacyPlatformTaskMode = mode != model.PlatformTaskOnly
			value.MaxConcurrent = 2
			got, err := PutConfiguration(t.Context(), d, principal, "worker", 7, value)
			if mode == model.PlatformTaskAll {
				requireFault(t, err, "worker_platform_task_mode_upgrade_required")
				if d.desiredWrites != 0 {
					t.Fatal("legacy exit wrote target")
				}
				continue
			}
			if err != nil || got.Desired.Value.PlatformTaskMode != model.PlatformTaskOnly || d.desiredWrites != 1 {
				t.Fatalf("preserve raw=%v mode=%s: %+v %v", rawStored, mode, got, err)
			}
		}
	}
	d := configuredDAO("7")
	d.current.Desired.Value.PlatformTaskMode = model.PlatformTaskOnly
	value := configurationFixture()
	got, err := PutConfiguration(t.Context(), d, principal, "worker", 7, value)
	if err != nil || got.Desired.Value.PlatformTaskMode != model.PlatformTaskAll {
		t.Fatalf("explicit exit: %+v %v", got, err)
	}
	_, err = PutConfiguration(t.Context(), d, principal, "worker", 6, value)
	requireFault(t, err, "version_conflict")
}
