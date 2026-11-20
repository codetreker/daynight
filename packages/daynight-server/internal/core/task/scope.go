package task

import (
	"errors"
	"maps"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func RequireReadAuthorization(a model.CredentialAuthorization, principal model.Principal, operations ...scopepolicy.Operation) error {
	if a.Principal != principal {
		return model.Unauthenticated(errors.New("task credential authorization identity changed"))
	}
	return scopeadmission.Require(a, append([]scopepolicy.Operation{scopepolicy.TaskRead}, operations...)...)
}

// WithoutSessionProperties excludes managed execution facts, including embedded
// Session identities, before task responses are serialized or budgeted.
func WithoutSessionProperties(task model.Task) model.Task {
	task.Properties = maps.Clone(task.Properties)
	delete(task.Properties, "worker")
	delete(task.Properties, "sessionStartup")
	return task
}

func ScopeUnavailableObservation() sp.TaskSessionObservation {
	return sp.TaskSessionObservation{SchemaVersion: 1, Observation: "unavailable", Registration: "unknown", Reason: "insufficient_scope", Send: sp.TaskSessionSend{Reason: "insufficient_scope"}, Error: &sp.OperationError{Code: "insufficient_scope", Message: "Session read permission is required."}}
}
