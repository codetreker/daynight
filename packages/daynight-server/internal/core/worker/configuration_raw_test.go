package worker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestUnsupportedStoredTargetCanBeReadAndExplicitlyReplaced(t *testing.T) {
	current := configurationFixture()
	raw, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	var old map[string]any
	if err := json.Unmarshal(raw, &old); err != nil {
		t.Fatal(err)
	}
	old["unsupportedSetting"] = map[string]any{"value": "retained"}
	raw, err = json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	dao := configuredDAO("7")
	dao.current.Desired.RawValue = raw
	encoded, err := json.Marshal(dao.current.Desired)
	if err != nil || !strings.Contains(string(encoded), `"unsupportedSetting"`) {
		t.Fatalf("stored target lost: %s %v", encoded, err)
	}
	ctx, principal := context.Background(), model.Principal{UserID: "user"}
	choice := &model.ToolPathChoice{Kind: "auto"}
	receipt, err := ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ToolPathsBootstrap: &model.WorkerToolPaths{Codex: choice, Copilot: choice}})
	if err != nil || dao.desiredWrites != 0 || !strings.Contains(string(receipt.Desired.RawValue), `"unsupportedSetting"`) {
		t.Fatalf("report rewrote target: %+v %v", receipt, err)
	}
	result, err := PutConfiguration(ctx, dao, principal, "worker", 7, current)
	if err != nil || dao.desiredWrites != 1 || result.Desired.Revision != "8" {
		t.Fatalf("explicit replacement: %+v %v", result, err)
	}
	if _, err := PutConfiguration(ctx, dao, principal, "worker", 6, current); err == nil {
		t.Fatal("stale replacement succeeded")
	}
}
