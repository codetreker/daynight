package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *Routes) logControllerFailure(ctx context.Context, phase, messageType string, err error) {
	if ctx.Err() != nil {
		return
	}
	logger := h.logger
	if phase == "controller_handle" {
		switch messageType {
		case "events", "source_reset", "operation_begin", "operation_receipt", "reconcile", "heartbeat", "content_response", "sync_state", "image_response", "image_capture":
			logger = logger.With("message_type", messageType)
		}
	}
	if phase := controllerStoragePhase(err); phase != "" {
		logger = logger.With("storage_phase", phase)
	}
	httpx.LogFailure(logger, ctx, "session", phase, err)
}

// Only operations used by the Controller path have diagnostic identifiers.
// A store error's phase is not itself a safe logging value.
var controllerStoragePhases = map[string]string{
	"lock session credential":              "session_credential_lock",
	"read session task":                    "session_task_read",
	"read session task properties":         "session_task_properties_read",
	"read session bot":                     "session_bot_read",
	"lock session":                         "session_lock",
	"read session scope":                   "session_scope_read",
	"read session grant":                   "session_grant_read",
	"read session operation":               "session_operation_read",
	"read accepted session operations":     "accepted_operations_read",
	"read unreconciled session operations": "unreconciled_operations_read",
	"read original source hash":            "source_hash_read",
	"read source ledger capacity":          "source_ledger_capacity_read",
	"read saved session resource":          "session_resource_read",
	"read resource budget":                 "resource_budget_read",
	"read image upload":                    "image_upload_read",
	"read image capture":                   "image_capture_read",
	"read media request":                   "media_request_read",
	"list pending media":                   "pending_media_list",
}

func controllerStoragePhase(err error) string {
	if err == nil {
		return ""
	}
	if failure, ok := err.(*store.Error); ok {
		if phase := controllerStoragePhases[failure.Phase]; phase != "" {
			return phase
		}
	}
	if causes, ok := err.(interface{ Unwrap() []error }); ok {
		for _, cause := range causes.Unwrap() {
			if phase := controllerStoragePhase(cause); phase != "" {
				return phase
			}
		}
		return ""
	}
	return controllerStoragePhase(errors.Unwrap(err))
}
