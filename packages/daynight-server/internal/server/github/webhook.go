package github

import (
	"bytes"
	"encoding/json"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"net/http"
	"strings"
	"time"
)

const webhookBodyLimit = 25 * 1024 * 1024
const webhookBudget = 8 * time.Second

func webhookHeader(r *http.Request, name string) string {
	values := r.Header.Values(name)
	if len(values) != 1 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

type webhookPayload struct {
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
}

func webhookEvent(event, delivery string, body []byte) (core.WebhookEvent, bool, bool) {
	var input core.WebhookEvent
	trimmed := bytes.TrimSpace(body)
	if event == "" || len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return input, false, false
	}
	switch event {
	case "installation", "installation_repositories":
	default:
		return input, false, true
	}
	var payload webhookPayload
	if delivery == "" || json.Unmarshal(trimmed, &payload) != nil || payload.Installation.ID < 1 {
		return input, false, false
	}
	input = core.WebhookEvent{Kind: "access", DeliveryID: delivery, InstallationID: payload.Installation.ID}
	return input, true, true
}
