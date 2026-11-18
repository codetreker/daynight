package github

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// ProjectWebhookReader reads connection and subscription from one snapshot.
type ProjectWebhookReader interface {
	GetWithProjectWebhook(context.Context, model.Principal, string) (core.ProjectAppStatus, core.ProjectWebhook, error)
}

// ProjectWebhookWriter applies a versioned subscription mutation.
type ProjectWebhookWriter interface {
	Update(context.Context, model.Principal, string, core.ProjectWebhookInput) (core.ProjectWebhook, error)
}

type projectWebhookResponse struct {
	Version        *string    `json:"version"`
	Enabled        bool       `json:"enabled"`
	RepositoryID   *string    `json:"repositoryId"`
	LastReceivedAt *time.Time `json:"lastReceivedAt"`
	WebhookURL     string     `json:"webhookUrl"`
	State          string     `json:"state"`
}

type projectAppWebhookStatus struct {
	api.GitHubProjectAppStatus
	ProjectWebhook projectWebhookResponse `json:"projectWebhook"`
}

func (h *projectAppHandler) webhookResponse(id string, hook core.ProjectWebhook) projectWebhookResponse {
	out := projectWebhookResponse{Enabled: hook.Enabled, WebhookURL: strings.TrimRight(h.webhookOrigin, "/") + "/api/v1/github/projects/" + id + "/webhook", State: "unconfigured"}
	if hook.Version != nil {
		version := decimal(*hook.Version)
		out.Version = &version
		out.State = "waiting"
		if !hook.Enabled {
			out.State = "disabled"
		} else if hook.CurrentRepositoryID != nil && hook.RepositoryID != nil && *hook.CurrentRepositoryID != *hook.RepositoryID {
			out.State = "repository_mismatch"
		} else if hook.LastReceivedAt != nil {
			out.State = "received"
		}
	}
	if hook.RepositoryID != nil {
		id := decimal(*hook.RepositoryID)
		out.RepositoryID = &id
	}
	if hook.LastReceivedAt != nil {
		at := hook.LastReceivedAt.UTC()
		out.LastReceivedAt = &at
	}
	return out
}

func (h *projectAppHandler) updateProjectWebhook(w http.ResponseWriter, r *http.Request, p model.Principal) {
	r = r.WithContext(httpx.WithRedactedOperationDiagnostics(r.Context()))
	h.run(w, r, p, "update_project_webhook", true, core.OperationTimeout, func(work *http.Request, id string, _ *projectAppLog) (any, error) {
		fields, err := configFields(w, work, core.OperationTimeout, "expectedUserId", "version", "enabled", "repositoryId", "secret")
		if err != nil {
			return nil, err
		}
		var in core.ProjectWebhookInput
		if in.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId"); err != nil {
			return nil, err
		}
		raw, present := fields["version"]
		if !present {
			return nil, httpx.InvalidInput("version is required")
		}
		if string(raw) != "null" {
			v, e := decimalField(fields, "version")
			if e != nil {
				return nil, e
			}
			in.Version = &v
		}
		var enabled *bool
		if err := json.Unmarshal(fields["enabled"], &enabled); err != nil || enabled == nil {
			return nil, httpx.InvalidInput("enabled must be a boolean")
		}
		in.Enabled = *enabled
		if _, present := fields["repositoryId"]; present {
			v, e := decimalField(fields, "repositoryId")
			if e != nil {
				return nil, e
			}
			in.RepositoryID = &v
		}
		if _, present := fields["secret"]; present {
			s, e := httpx.RequiredString(fields, "secret")
			if e != nil {
				return nil, e
			}
			if len(s) == 0 || len(s) > 4096 {
				return nil, httpx.InvalidInput("secret must contain 1 to 4096 UTF-8 bytes")
			}
			in.Secret = &s
		}
		out, err := h.webhookWriter.Update(work.Context(), p, id, in)
		if err != nil {
			return nil, err
		}
		return h.webhookResponse(id, out), nil
	})
}
