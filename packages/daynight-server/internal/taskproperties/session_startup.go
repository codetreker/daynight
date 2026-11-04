package taskproperties

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
)

func normalizeSessionStartup(raw json.RawMessage) (json.RawMessage, error) {
	value, err := sp.DecodeStartupReport(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func SessionStartup(properties core.TaskProperties) (*sp.StartupReport, error) {
	raw, exists := properties["sessionStartup"]
	if !exists {
		return nil, nil
	}
	value, err := sp.DecodeStartupReport(raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func sessionStartupSchema() json.RawMessage {
	sequence := map[string]any{"type": "string", "pattern": "^[1-9][0-9]{0,18}$", "description": "Positive decimal integer no greater than 9223372036854775807."}
	startup := objectSchema(map[string]any{"state": enumSchema("unknown", "starting", "ready", "failed"), "reasonCode": enumSchema("evidence_missing", "initializing", "ready", "native_rejected", "native_timeout", "native_transport_unknown", "controller_start_unknown", "controller_launch_failed")}, "state", "reasonCode")
	startup["description"] = "starting requires initializing; ready requires ready; failed requires native_rejected or controller_launch_failed; unknown requires another listed reason."
	recovery := objectSchema(map[string]any{"state": enumSchema("none", "blocked"), "reasonCode": nullableSchema(enumSchema("native_identity_missing", "recovery_limit", "recovery_blocked"))}, "state", "reasonCode")
	recovery["description"] = "none requires null reasonCode; blocked requires a listed non-null reasonCode."
	return schemaJSON(objectSchema(map[string]any{
		"schemaVersion": map[string]any{"type": "integer", "const": 1}, "source": enumSchema("worker"),
		"sessionId": uuidSchema(), "claimId": uuidSchema(), "executionGeneration": sequence, "controllerInstanceId": uuidSchema(), "revision": sequence,
		"observedAt": map[string]any{"type": "string", "format": "date-time", "pattern": "Z$"}, "startup": startup, "recovery": recovery,
	}, "schemaVersion", "source", "sessionId", "claimId", "executionGeneration", "controllerInstanceId", "revision", "observedAt", "startup", "recovery"))
}
