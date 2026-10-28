package sessionprotocol

import "encoding/json"

// TestRegistration deliberately has no task, worker, project, or claim binding.
type TestRegistration struct {
	Protocol             string `json:"protocol"`
	SchemaVersion        int    `json:"schemaVersion"`
	ProjectionVersion    int    `json:"projectionVersion"`
	RegistrationID       string `json:"registrationId"`
	TestExecutionID      string `json:"testExecutionId"`
	ControllerID         string `json:"controllerId"`
	ControllerInstanceID string `json:"controllerInstanceId"`
	Provider             string `json:"provider"`
	InitialInput         string `json:"initialInput"`
}
type TestStop struct {
	Fence
	Protocol             string    `json:"protocol"`
	ControllerID         string    `json:"controllerId"`
	ControllerInstanceID string    `json:"controllerInstanceId"`
	StopProof            StopProof `json:"stopProof"`
}

func DecodeTestRegistration(data []byte) (TestRegistration, error) {
	return decodeVersioned[TestRegistration](data, schema{"protocol": enum(Protocol), "schemaVersion": version, "projectionVersion": version, "registrationId": identifier, "testExecutionId": identifier, "controllerId": identifier, "controllerInstanceId": identifier, "provider": enum("codex", "claude", "copilot"), "initialInput": enum("none", "prompt")})
}
func DecodeTestGrant(data []byte) (Grant, error) {
	return decode[Grant](data, nested(schema{"protocol": enum(Protocol), "testExecutionId": identifier, "controllerId": identifier, "controllerInstanceId": identifier, "executionGeneration": sequence, "kind": enum("bootstrap", "reconnect"), "previousGeneration": null, "stopProof": null}))
}
func DecodeTestStop(data []byte) (TestStop, error) {
	return decode[TestStop](data, nested(schema{"protocol": enum(Protocol), "sessionId": identifier, "testExecutionId": identifier, "executionGeneration": sequence, "controllerId": identifier, "controllerInstanceId": identifier, "stopProof": validateTestStopProof}))
}

// BindingFields constructs the exact wire branch without inventing a claim.
func BindingFields(f Fence, fields map[string]any) map[string]any {
	if f.TestExecutionID != "" {
		delete(fields, "claimId")
		fields["testExecutionId"] = f.TestExecutionID
	}
	return fields
}

func validateTestStopProof(data json.RawMessage) bool {
	fields := schema{"recordId": identifier, "previousControllerInstanceId": identifier, "stoppedAt": timestamp}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(data, &raw)
	if _, ok := raw["kind"]; ok {
		fields["kind"] = enum("never_started")
	}
	return validateObject(data, fields)
}
