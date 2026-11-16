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

type webhookPRPayload struct {
	webhookPayload
	Repository struct {
		ID int64 `json:"id"`
	} `json:"repository"`
	Number int64 `json:"number"`
}

func webhookEvent(event, delivery string, body []byte) (core.WebhookEvent, bool, bool) {
	var input core.WebhookEvent
	trimmed := bytes.TrimSpace(body)
	if event == "" || len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return input, false, false
	}
	kind := ""
	switch event {
	case "pull_request":
		kind = "pull_request"
	case "installation", "installation_repositories", "repository":
		kind = "access"
	default:
		return input, false, true
	}
	var payload webhookPayload
	if delivery == "" || json.Unmarshal(trimmed, &payload) != nil || payload.Installation.ID < 1 {
		return input, false, false
	}
	input = core.WebhookEvent{Kind: kind, DeliveryID: delivery, InstallationID: payload.Installation.ID}
	if kind == "pull_request" {
		var pr webhookPRPayload
		if json.Unmarshal(trimmed, &pr) != nil || pr.Repository.ID < 1 || pr.Number < 1 {
			return core.WebhookEvent{}, false, false
		}
		input.RepositoryID, input.Number = pr.Repository.ID, pr.Number
	}
	return input, true, true
}
