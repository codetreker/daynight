package bot

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

var recoveryIdentityKeys = []string{"botRecoveryVersion", "serviceOrigin", "recoveryIdentity"}
var recoveryBindingKeys = []string{"sessionId", "testExecutionId", "nativeSessionId"}

func recoverySecret(value, prefix string) bool {
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	value = strings.TrimPrefix(value, prefix)
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func recoveryUUID(fields map[string]json.RawMessage, key string) error {
	value, err := httpx.RequiredString(fields, key)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(value)
	if err != nil || id == uuid.Nil || id.String() != value {
		return httpx.InvalidInput("Bot recovery identity must be a canonical nonzero UUID.")
	}
	return nil
}

func recoveryIdentityInput(fields map[string]json.RawMessage) (sessioncore.BotRecoveryIdentity, error) {
	var input sessioncore.BotRecoveryIdentity
	if !bytes.Equal(bytes.TrimSpace(fields["botRecoveryVersion"]), []byte("1")) {
		return input, &model.Fault{Code: "upgrade_required", Message: "Bot recovery version 1 is required."}
	}
	var err error
	if input.ServiceOrigin, err = httpx.RequiredString(fields, "serviceOrigin"); err != nil {
		return input, err
	}
	if input.RecoveryIdentity, err = httpx.RequiredString(fields, "recoveryIdentity"); err != nil {
		return input, err
	}
	if !recoverySecret(input.RecoveryIdentity, "") {
		return input, httpx.InvalidInput("Invalid Bot recovery identity.")
	}
	input.BotRecoveryVersion = 1
	return input, nil
}

func recoveryBindingInput(fields map[string]json.RawMessage) error {
	for _, key := range []string{"sessionId", "testExecutionId"} {
		if err := recoveryUUID(fields, key); err != nil {
			return err
		}
	}
	if !bytes.Equal(bytes.TrimSpace(fields["nativeSessionId"]), []byte("null")) {
		value, err := httpx.RequiredString(fields, "nativeSessionId")
		if err != nil {
			return err
		}
		if strings.TrimSpace(value) == "" || strings.ContainsRune(value, 0) {
			return httpx.InvalidInput("Invalid native Session identity.")
		}
	}
	return nil
}

func botRecoveryRegistrationInput(raw []byte) (sessioncore.BotRecoveryRegistration, error) {
	var input sessioncore.BotRecoveryRegistration
	keys := append(append(append([]string{}, recoveryIdentityKeys...), recoveryBindingKeys...), "operationId", "botVersion")
	fields, err := botRuntimeObject(raw, keys...)
	if err != nil {
		return input, err
	}
	if _, err = recoveryIdentityInput(fields); err != nil {
		return input, err
	}
	if err = recoveryBindingInput(fields); err != nil {
		return input, err
	}
	if err = recoveryUUID(fields, "operationId"); err != nil {
		return input, err
	}
	if err = botRuntimeVersion(fields["botVersion"]); err != nil {
		return input, err
	}
	if err = json.Unmarshal(raw, &input); err != nil {
		return input, httpx.InvalidInput("Invalid Bot recovery registration.")
	}
	return input, nil
}

func botRecoveryGrantInput(raw []byte) (sessioncore.BotRecoveryGrant, error) {
	var input sessioncore.BotRecoveryGrant
	keys := append(append(append([]string{}, recoveryIdentityKeys...), recoveryBindingKeys...), "operationId", "expectedHostingGeneration", "grant", "controllerToken")
	fields, err := botRuntimeObject(raw, keys...)
	if err != nil {
		return input, err
	}
	if _, err = recoveryIdentityInput(fields); err != nil {
		return input, err
	}
	if err = recoveryBindingInput(fields); err != nil {
		return input, err
	}
	if err = recoveryUUID(fields, "operationId"); err != nil {
		return input, err
	}
	if err = botRuntimeVersion(fields["expectedHostingGeneration"]); err != nil {
		return input, err
	}
	if _, err = sp.DecodeBotGrant(fields["grant"]); err != nil {
		return input, httpx.InvalidInput("Invalid Bot recovery grant.")
	}
	token, err := httpx.RequiredString(fields, "controllerToken")
	if err != nil {
		return input, err
	}
	if !recoverySecret(token, "dncontroller_") {
		return input, httpx.InvalidInput("Invalid recovery controller token.")
	}
	if err = json.Unmarshal(raw, &input); err != nil {
		return input, httpx.InvalidInput("Invalid Bot recovery grant.")
	}
	return input, nil
}

func botRecoveryReportInput(raw []byte) (sessioncore.BotRecoveryReport, error) {
	var input sessioncore.BotRecoveryReport
	fields, err := botRuntimeObject(raw, append(append([]string{}, recoveryIdentityKeys...), "hostingGeneration", "report")...)
	if err != nil {
		return input, err
	}
	if input.BotRecoveryIdentity, err = recoveryIdentityInput(fields); err != nil {
		return input, err
	}
	if err = botRuntimeVersion(fields["hostingGeneration"]); err != nil {
		return input, err
	}
	if input.Report, err = botReportInput(fields["report"]); err != nil {
		return input, err
	}
	if !botcore.ValidStartupResult(input.Report.Result) {
		return input, httpx.InvalidInput("Invalid Bot startup result.")
	}
	if input.Report.NativeSessionID != nil && (strings.TrimSpace(*input.Report.NativeSessionID) == "" || strings.ContainsRune(*input.Report.NativeSessionID, 0)) {
		return input, httpx.InvalidInput("Invalid native Session identity.")
	}
	if input.Report.Fence != nil {
		var reportFields map[string]json.RawMessage
		var fenceFields map[string]json.RawMessage
		_ = json.Unmarshal(fields["report"], &reportFields)
		_ = json.Unmarshal(reportFields["fence"], &fenceFields)
		for _, key := range []string{"sessionId", "testExecutionId"} {
			if err = recoveryUUID(fenceFields, key); err != nil {
				return input, err
			}
		}
		if err = botRuntimeVersion(fenceFields["executionGeneration"]); err != nil {
			return input, err
		}
		if !bytes.Equal(bytes.TrimSpace(fenceFields["connectionEpoch"]), []byte(`"0"`)) {
			if err = botRuntimeVersion(fenceFields["connectionEpoch"]); err != nil {
				return input, err
			}
		}
	}
	if err = json.Unmarshal(raw, &input); err != nil {
		return input, httpx.InvalidInput("Invalid Bot recovery report.")
	}
	return input, nil
}

func botRecoveryQueryInput(raw []byte) (sessioncore.BotRecoveryIdentity, error) {
	fields, err := botRuntimeObject(raw, recoveryIdentityKeys...)
	if err != nil {
		return sessioncore.BotRecoveryIdentity{}, err
	}
	return recoveryIdentityInput(fields)
}
