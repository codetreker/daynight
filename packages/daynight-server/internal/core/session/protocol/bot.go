package sessionprotocol

// DecodeBotGrant retains the independent wire identity while permitting proven
// generation recovery only through the Bot lifecycle endpoint.
func DecodeBotGrant(data []byte) (Grant, error) {
	value, err := decode[Grant](data, nested(schema{
		"protocol": enum(Protocol), "testExecutionId": identifier, "controllerId": identifier,
		"controllerInstanceId": identifier, "executionGeneration": sequence, "kind": enum("bootstrap", "reconnect"),
		"previousGeneration": optional(sequence), "stopProof": optional(nested(schema{
			"recordId": identifier, "previousControllerInstanceId": identifier, "stoppedAt": timestamp,
		})),
	}))
	if err != nil {
		return Grant{}, err
	}
	if (value.PreviousGeneration == nil) != (value.StopProof == nil) {
		return Grant{}, errInvalid
	}
	return value, nil
}
