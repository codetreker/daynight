package v2

// Automation recovery is a separately acknowledged shutdown transition. Ordinary
// control-state publication and network registration cannot restore input rights.
type AutomationRecoveryPrepare struct {
	RecoveryID          string  `json:"recoveryId"`
	ConnectionEpoch     string  `json:"connectionEpoch"`
	ControlEpoch        string  `json:"controlEpoch"`
	ClosingControlEpoch string  `json:"closingControlEpoch"`
	StopOperationID     string  `json:"stopOperationId"`
	Binding             Binding `json:"binding"`
	InitialAssignment   string  `json:"initialAssignment"`
}
type AutomationRecovery struct {
	RecoveryID         string  `json:"recoveryId"`
	ConnectionEpoch    string  `json:"connectionEpoch"`
	ControlEpoch       string  `json:"controlEpoch"`
	PreviousGeneration string  `json:"previousGeneration"`
	StopOperationID    string  `json:"stopOperationId"`
	Binding            Binding `json:"binding"`
}
type AutomationRecoveryConsumption struct {
	ExecutionGeneration string `json:"executionGeneration"`
	ConnectionEpoch     string `json:"connectionEpoch"`
	ControlEpoch        string `json:"controlEpoch"`
	RequestDigest       string `json:"requestDigest"`
}
type AutomationRecoveryState struct {
	RecoveryID            string                         `json:"recoveryId"`
	PrepareDigest         string                         `json:"prepareDigest"`
	SourceGeneration      string                         `json:"sourceGeneration"`
	SourceConnectionEpoch string                         `json:"sourceConnectionEpoch"`
	SourceControlEpoch    string                         `json:"sourceControlEpoch"`
	ClosingControlEpoch   string                         `json:"closingControlEpoch"`
	StopOperationID       string                         `json:"stopOperationId"`
	NativeSessionID       string                         `json:"nativeSessionId"`
	Consumed              *AutomationRecoveryConsumption `json:"consumed"`
}

func (AutomationRecoveryPrepare) sessionPayload() string { return "automation_recovery_prepare" }
func (AutomationRecovery) sessionPayload() string        { return "automation_recovery" }
func (AutomationRecoveryState) sessionPayload() string   { return "automation_recovery_state" }

func validAutomationRecovery(kind string, value any, generation string) bool {
	m := mapAt(value)
	switch kind {
	case "automation_recovery_prepare":
		return object(value, fields{"recoveryId": uuid, "connectionEpoch": positive, "controlEpoch": positive, "closingControlEpoch": positive, "stopOperationId": uuid, "binding": nested(bindingSchema), "initialAssignment": literal("transport_completed")}) && mapAt(m["binding"])["nativeSessionId"] != nil && decimalValue(stringAt(m["closingControlEpoch"])) > decimalValue(stringAt(m["controlEpoch"]))
	case "automation_recovery":
		return object(value, fields{"recoveryId": uuid, "connectionEpoch": positive, "controlEpoch": positive, "previousGeneration": positive, "stopOperationId": uuid, "binding": nested(bindingSchema)}) && mapAt(m["binding"])["nativeSessionId"] != nil && decimalValue(stringAt(m["previousGeneration"])) < 9223372036854775807 && decimalValue(stringAt(m["previousGeneration"]))+1 == decimalValue(generation)
	case "automation_recovery_state":
		if !object(value, fields{"recoveryId": uuid, "prepareDigest": hash, "sourceGeneration": positive, "sourceConnectionEpoch": positive, "sourceControlEpoch": positive, "closingControlEpoch": positive, "stopOperationId": uuid, "nativeSessionId": native, "consumed": nullable(nested(fields{"executionGeneration": positive, "connectionEpoch": positive, "controlEpoch": positive, "requestDigest": hash}))}) {
			return false
		}
		if decimalValue(stringAt(m["closingControlEpoch"])) <= decimalValue(stringAt(m["sourceControlEpoch"])) {
			return false
		}
		c := mapAt(m["consumed"])
		if c == nil {
			return m["sourceGeneration"] == generation
		}
		return decimalValue(stringAt(m["sourceGeneration"])) < 9223372036854775807 && decimalValue(stringAt(m["sourceGeneration"]))+1 == decimalValue(stringAt(c["executionGeneration"])) && c["executionGeneration"] == generation && decimalValue(stringAt(c["connectionEpoch"])) > decimalValue(stringAt(m["sourceConnectionEpoch"])) && decimalValue(stringAt(c["controlEpoch"])) > decimalValue(stringAt(m["closingControlEpoch"]))
	}
	return false
}
