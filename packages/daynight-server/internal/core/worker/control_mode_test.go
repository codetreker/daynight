package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"math"
	"strconv"
	"strings"
	"testing"
)

func TestControlModeConfigurationAndExchangeInput(t *testing.T) {
	for _, mode := range []any{"herdr", "web", nil} {
		document := configurationInputDocument()
		document["agentControlMode"] = mode
		value, err := ParseWorkerConfiguration(configurationInputJSON(t, document))
		if err != nil {
			t.Fatalf("valid mode %v rejected: %v", mode, err)
		}
		raw, _ := json.Marshal(value)
		var fields map[string]any
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		if fields["agentControlMode"] != mode {
			t.Fatalf("mode lost: %s", raw)
		}
	}
	for _, mode := range []any{"local", "", 1, true, []any{}} {
		document := configurationInputDocument()
		document["agentControlMode"] = mode
		if _, err := ParseWorkerConfiguration(configurationInputJSON(t, document)); err == nil {
			t.Fatalf("invalid mode accepted: %v", mode)
		}
	}
	document := map[string]any{"bootstrap": nil, "observation": nil, "controlModeBootstrap": "web"}
	if _, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, document)); err != nil {
		t.Fatalf("standalone bootstrap rejected: %v", err)
	}
	item := configurationInputItem("agentControlMode", "web")
	if _, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, configurationInputExchange(item))); err != nil {
		t.Fatalf("mode observation rejected: %v", err)
	}
}

func TestControlModeAdoptionAndLegacyReplacement(t *testing.T) {
	ctx, principal := context.Background(), model.Principal{UserID: "user"}
	web, herdr := model.AgentControlModeWeb, model.AgentControlModeHerdr
	t.Run("adopt existing local web once", func(t *testing.T) {
		dao := configuredDAO("7")
		dao.current.Desired.Value.MaxConcurrent = 9
		receipt, err := ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ControlModeBootstrap: &web})
		if err != nil || receipt.Desired.Revision != "8" || receipt.Desired.Value.AgentControlMode == nil || *receipt.Desired.Value.AgentControlMode != web || receipt.Desired.Value.MaxConcurrent != 9 || dao.desiredWrites != 1 {
			t.Fatalf("adoption: %+v %v writes=%d", receipt, err, dao.desiredWrites)
		}
		dao.current.Desired = receipt.Desired
		receipt, err = ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ControlModeBootstrap: &herdr})
		if err != nil || receipt.Desired.Revision != "8" || *receipt.Desired.Value.AgentControlMode != web || dao.desiredWrites != 1 {
			t.Fatalf("late adoption overwrote selected mode: %+v %v", receipt, err)
		}
	})
	t.Run("fresh bootstrap is revision one", func(t *testing.T) {
		value := configurationFixture()
		value.AgentControlMode = &web
		dao := &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}}
		receipt, err := ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &value, ControlModeBootstrap: &herdr})
		if err != nil || receipt.Desired.Revision != "1" || *receipt.Desired.Value.AgentControlMode != web || dao.desiredWrites != 1 {
			t.Fatalf("fresh bootstrap: %+v %v", receipt, err)
		}
	})
	t.Run("legacy replacement preserves mode", func(t *testing.T) {
		dao := configuredDAO("2")
		dao.current.Desired.Value.AgentControlMode = &web
		value := configurationFixture()
		value.MaxConcurrent = 2
		value.PreserveAgentControlMode = true
		result, err := PutConfiguration(ctx, dao, principal, "worker", 2, value)
		if err != nil || result.Desired.Value.AgentControlMode == nil || *result.Desired.Value.AgentControlMode != web || result.Desired.Value.PreserveAgentControlMode || result.Desired.Revision != "3" {
			t.Fatalf("legacy replacement: %+v %v", result, err)
		}
		value.PreserveAgentControlMode = false
		_, err = PutConfiguration(ctx, dao, principal, "worker", 2, value)
		requireFault(t, err, "invalid_input")
	})
	t.Run("adoption version exhausted and storage errors", func(t *testing.T) {
		dao := configuredDAO(strconv.FormatInt(math.MaxInt64, 10))
		_, err := ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ControlModeBootstrap: &web})
		requireFault(t, err, "version_exhausted")
		if dao.desiredWrites != 0 {
			t.Fatal("exhausted mode was written")
		}
		dao = configuredDAO("1")
		dao.desiredErr = errors.New("unavailable")
		_, err = ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ControlModeBootstrap: &web})
		if !errors.Is(err, dao.desiredErr) {
			t.Fatalf("adoption lost write failure: %v", err)
		}
	})
}

func TestControlModeProtocolRequiresNegotiatedShape(t *testing.T) {
	for _, aware := range []bool{false, true} {
		document := configurationInputDocument()
		if aware {
			document["agentControlMode"] = nil
		}
		value, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: aware})
		if err != nil || value.PreserveAgentControlMode == aware {
			t.Fatalf("valid shape aware=%v: %+v %v", aware, value, err)
		}
		if aware {
			delete(document, "agentControlMode")
		} else {
			document["agentControlMode"] = "web"
		}
		if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: aware}); err == nil {
			t.Fatalf("mismatched value shape accepted: %v", aware)
		}
	}
	for _, raw := range []string{
		`{"bootstrap":null,"observation":null,"controlModeBootstrap":"web","controlModeBootstrap":"herdr"}`,
		`{"bootstrap":null,"observation":null,"controlModeBootstrap":1}`,
		`{"bootstrap":null,"observation":null,"controlModeBootstrap":"unknown"}`,
	} {
		if _, err := ParseWorkerConfigurationExchangeProtocol([]byte(raw), workerprotocol.Capabilities{ControlMode: true}); err == nil {
			t.Fatalf("invalid candidate accepted: %s", raw)
		}
	}
	for _, mode := range []any{"web", "herdr", nil} {
		document := configurationInputDocument()
		document["agentControlMode"] = mode
		exchange := map[string]any{"bootstrap": document, "observation": nil, "controlModeBootstrap": mode}
		value, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, exchange), workerprotocol.Capabilities{ControlMode: true})
		if mode == nil {
			if err == nil {
				t.Fatal("null fresh mode accepted")
			}
		} else if err != nil || value.Bootstrap.AgentControlMode == nil {
			t.Fatalf("valid bootstrap rejected: %v", err)
		}
	}
	for _, applied := range []any{"web", "herdr", nil, "desktop", 1, true} {
		item := configurationInputItem("agentControlMode", applied)
		document := configurationInputExchange(item)
		document["controlModeBootstrap"] = nil
		_, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: true})
		valid := applied == "web" || applied == "herdr"
		if (err == nil) != valid {
			t.Fatalf("observation %v: %v", applied, err)
		}
		delete(document, "controlModeBootstrap")
		if _, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: false}); err == nil {
			t.Fatal("legacy mode observation accepted")
		}
	}
	document := configurationInputDocument()
	document["agentControlMode"] = "web"
	document["projects"] = []any{map[string]any{"projectId": configurationInputProjectA, "nativeOverrides": map[string]any{"agentControlMode": "herdr"}}}
	if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: true}); err == nil {
		t.Fatal("project mode override accepted")
	}
}

func TestControlModeMergeChecksFinalEncodedBudget(t *testing.T) {
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
	web := model.AgentControlModeWeb
	ctx, principal := context.Background(), model.Principal{UserID: "user"}
	dao := configuredDAO("1")
	dao.current.Desired.Value.AgentControlMode = &web
	value.PreserveAgentControlMode = true
	_, err := PutConfiguration(ctx, dao, principal, "worker", 1, value)
	requireFault(t, err, "invalid_input")
	if dao.desiredWrites != 0 {
		t.Fatal("over-budget merged replacement persisted")
	}
	value.PreserveAgentControlMode = false
	dao = configuredDAO("1")
	dao.current.Desired.Value = value
	_, err = ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ControlModeBootstrap: &web})
	requireFault(t, err, "invalid_input")
	if dao.desiredWrites != 0 {
		t.Fatal("over-budget adopted configuration persisted")
	}
}

func TestControlModeObservationBudgetPreservesLegacyProjection(t *testing.T) {
	document := map[string]any{"bootstrap": nil, "observation": configurationCapacityObservationDocument(MaxObservationItems-1, "0"), "controlModeBootstrap": nil}
	if _, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: true}); err != nil {
		t.Fatalf("legacy collection rejected: %v", err)
	}
	document["observation"] = configurationCapacityObservationDocument(MaxObservationItems, "0")
	if _, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: true}); err == nil {
		t.Fatal("1026 non-mode entries would exceed legacy projection")
	}
	observation := document["observation"].(map[string]any)
	items := observation["items"].([]any)
	modeItem := configurationInputItem("agentControlMode", "web")
	modeItem["targetRevision"] = "1"
	items[len(items)-1] = modeItem
	if _, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: true}); err != nil {
		t.Fatalf("1025 old entries plus mode rejected: %v", err)
	}
	delete(document, "controlModeBootstrap")
	if _, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ControlMode: false}); err == nil {
		t.Fatal("legacy exchange accepted mode item")
	}
}
