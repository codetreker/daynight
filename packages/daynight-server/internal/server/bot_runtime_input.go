package server

import (
	"bytes"
	"encoding/json"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonunicode"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
)

func botRuntimeObject(raw []byte, keys ...string) (map[string]json.RawMessage, error) {
	fields, err := jsonobject.Decode(raw, "Bot runtime request", keys...)
	if err != nil || len(fields) != len(keys) || !jsonunicode.Valid(raw) {
		return nil, invalidInput("Bot runtime request must contain exactly the required fields and valid Unicode.")
	}
	return fields, nil
}

func botRuntimeVersion(raw json.RawMessage) error {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return invalidInput("botVersion must be a positive int64 decimal string.")
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != value {
		return invalidInput("botVersion must be a positive int64 decimal string.")
	}
	return nil
}

func botRegisterInput(raw []byte) (sessionrelay.BotRegistration, error) {
	var input sessionrelay.BotRegistration
	fields, err := botRuntimeObject(raw, "botVersion", "registration", "configuration", "roleConfiguration")
	if err != nil {
		return input, err
	}
	if err = botRuntimeVersion(fields["botVersion"]); err != nil {
		return input, err
	}
	if _, err = sp.DecodeTestRegistration(fields["registration"]); err != nil {
		return input, invalidInput("Invalid Bot session registration.")
	}
	configuration, err := botRuntimeObject(fields["configuration"], "workerId", "cwd", "provider", "model", "args")
	if err != nil {
		return input, err
	}
	if bytes.Equal(bytes.TrimSpace(configuration["args"]), []byte("null")) {
		return input, invalidInput("Bot configuration args must be an array.")
	}
	var args []json.RawMessage
	if json.Unmarshal(configuration["args"], &args) != nil {
		return input, invalidInput("Bot configuration args must be an array of strings.")
	}
	for _, arg := range args {
		var value string
		if bytes.Equal(bytes.TrimSpace(arg), []byte("null")) || json.Unmarshal(arg, &value) != nil {
			return input, invalidInput("Bot configuration args must contain only strings.")
		}
	}
	if _, err = botRuntimeObject(fields["roleConfiguration"], "instructions", "revision", "digest"); err != nil {
		return input, err
	}
	if err = json.Unmarshal(raw, &input); err != nil {
		return input, invalidInput("Invalid Bot registration values.")
	}
	return input, nil
}

func botGrantInput(raw []byte) (sessionrelay.BotGrant, error) {
	var input sessionrelay.BotGrant
	fields, err := botRuntimeObject(raw, "botVersion", "grant", "nativeSessionId")
	if err != nil {
		return input, err
	}
	if err = botRuntimeVersion(fields["botVersion"]); err != nil {
		return input, err
	}
	if input.Grant, err = sp.DecodeBotGrant(fields["grant"]); err != nil {
		return input, invalidInput("Invalid Bot controller grant.")
	}
	if err = json.Unmarshal(raw, &input); err != nil {
		return input, invalidInput("Invalid Bot grant values.")
	}
	return input, nil
}

func botReportInput(raw []byte) (sessionrelay.BotReport, error) {
	var input sessionrelay.BotReport
	fields, err := botRuntimeObject(raw, "botVersion", "fence", "controllerId", "controllerInstanceId", "nativeSessionId", "result")
	if err != nil {
		return input, err
	}
	if err = botRuntimeVersion(fields["botVersion"]); err != nil {
		return input, err
	}
	if _, err = botRuntimeObject(fields["result"], "state", "code"); err != nil {
		return input, err
	}
	if !bytes.Equal(bytes.TrimSpace(fields["fence"]), []byte("null")) {
		if _, err = botRuntimeObject(fields["fence"], "sessionId", "testExecutionId", "executionGeneration", "connectionEpoch"); err != nil {
			return input, err
		}
	}
	for _, key := range []string{"controllerId", "controllerInstanceId"} {
		if bytes.Equal(bytes.TrimSpace(fields[key]), []byte("null")) {
			return input, invalidInput("Bot controller identity must be a string.")
		}
	}
	if err = json.Unmarshal(raw, &input); err != nil {
		return input, invalidInput("Invalid Bot report values.")
	}
	return input, nil
}
