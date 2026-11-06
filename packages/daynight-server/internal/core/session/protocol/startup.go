package sessionprotocol

import (
	"encoding/json"
)

// StartupReport is a Worker observation, not authority to launch or recover a native session.
type StartupReport struct {
	SchemaVersion        int    `json:"schemaVersion"`
	Source               string `json:"source"`
	SessionID            string `json:"sessionId"`
	ClaimID              string `json:"claimId"`
	ExecutionGeneration  string `json:"executionGeneration"`
	ControllerInstanceID string `json:"controllerInstanceId"`
	Revision             string `json:"revision"`
	ObservedAt           string `json:"observedAt"`
	Startup              struct {
		State      string `json:"state"`
		ReasonCode string `json:"reasonCode"`
	} `json:"startup"`
	Recovery struct {
		State      string  `json:"state"`
		ReasonCode *string `json:"reasonCode"`
	} `json:"recovery"`
}

func DecodeStartupReport(data []byte) (StartupReport, error) {
	value, err := decodeVersioned[StartupReport](data, schema{
		"schemaVersion": version, "source": enum("worker"), "sessionId": identifier, "claimId": identifier,
		"executionGeneration": sequence, "controllerInstanceId": identifier, "revision": sequence,
		"observedAt": func(raw json.RawMessage) bool {
			return timestamp(raw) && pattern(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`)(raw)
		},
		"startup":  nested(schema{"state": enum("unknown", "starting", "ready", "failed"), "reasonCode": enum("evidence_missing", "initializing", "ready", "native_rejected", "native_timeout", "native_transport_unknown", "controller_start_unknown", "controller_launch_failed")}),
		"recovery": nested(schema{"state": enum("none", "blocked"), "reasonCode": optional(enum("native_identity_missing", "recovery_limit", "recovery_blocked"))}),
	})
	if err != nil {
		return StartupReport{}, err
	}
	// This summary belongs to an assigned Task, never a Test Session binding.
	if value.ClaimID == "" || (value.Recovery.State == "none") != (value.Recovery.ReasonCode == nil) {
		return StartupReport{}, errInvalid
	}
	expected := "unknown"
	switch value.Startup.ReasonCode {
	case "initializing":
		expected = "starting"
	case "ready":
		expected = "ready"
	case "native_rejected", "controller_launch_failed":
		expected = "failed"
	}
	if value.Startup.State != expected {
		return StartupReport{}, errInvalid
	}
	return value, nil
}
