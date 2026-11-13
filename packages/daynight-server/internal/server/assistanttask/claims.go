package assistanttask

import (
	"encoding/base64"
	"net/http"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (p *inputFields) token(required bool) string {
	value := p.text("claimToken", required)
	if p.err != nil || !required && p.fields["claimToken"] == nil {
		return ""
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != value {
		p.err = httpx.InvalidInput("claimToken must encode exactly 32 bytes as unpadded base64url")
		return ""
	}
	return value
}
func (h *handler) claim(kind string) requestOperation {
	return func(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
		if err := noQuery(r); err != nil {
			return nil, err
		}
		allowed := []string{"operationId"}
		switch kind {
		case "claim":
			allowed = append(allowed, "ifVersion", "expectedGeneration", "claimToken")
		case "transfer":
			allowed = append(allowed, "ifVersion", "expectedGeneration", "targetBotId")
			if a.BotID != nil {
				allowed = append(allowed, "claimToken")
			}
		case "bind":
			allowed = append(allowed, "expectedGeneration", "claimToken")
		case "renew":
			allowed = append(allowed, "claimGeneration", "claimToken")
		case "release":
			allowed = append(allowed, "expectedGeneration")
			if a.BotID != nil {
				allowed = append(allowed, "claimToken")
			} else {
				allowed = append(allowed, "ifVersion")
			}
		}
		fields, err := httpx.DecodeObject(w, r, allowed...)
		if err != nil {
			return nil, err
		}
		p := inputFields{fields: fields}
		input := core.ClaimInput{TaskID: taskID, OperationID: p.id("operationId", true), Kind: kind}
		if kind == "claim" || kind == "transfer" || kind == "release" && a.BotID == nil {
			version := p.integer("ifVersion", true, false)
			input.IfVersion = &version
		}
		generationKey := "expectedGeneration"
		if kind == "renew" {
			generationKey = "claimGeneration"
		}
		input.ExpectedGeneration = p.integer(generationKey, true, kind == "claim" || kind == "transfer")
		if kind == "claim" || kind == "bind" || kind == "renew" || a.BotID != nil {
			input.ClaimToken = p.token(true)
		}
		if kind == "transfer" {
			target := p.id("targetBotId", true)
			input.TargetBotID = &target
		}
		if p.err != nil {
			return nil, p.err
		}
		value, err := h.tasks.Claim(r.Context(), a, input)
		return claimResultResponse(value), err
	}
}
