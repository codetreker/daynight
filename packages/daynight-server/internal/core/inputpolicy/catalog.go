// Package inputpolicy identifies the candidate limits shared by inventory and admission.
package inputpolicy

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessionv2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

// Version identifies the meaning and numeric values of this catalog.
const Version = "daynight-api-input-limits/v1"

// Entry associates a stable policy identifier with its bounds. The upper bound
// is inclusive unless UpperExclusive is true. Min is inclusive when HasMin is set.
type Entry struct {
	ID             string
	Max            int64
	Unit           string
	Min            int64
	HasMin         bool
	UpperExclusive bool
}

// Catalog returns an independent copy so callers cannot mutate the policy source.
func Catalog() []Entry {
	return []Entry{
		{ID: "attachment.metadataPage", Max: attachment.MaxMetadataPageResponseJSONBytes, Unit: "bytes"},
		{ID: "bot.name", Max: bot.MaxNameCodePoints, Unit: "code points", Min: 1, HasMin: true},
		{ID: "bot.cwd", Max: bot.MaxCwdBytes, Unit: "bytes"},
		{ID: "attachment.content", Max: attachment.MaxContentBytes, Unit: "bytes", Min: 0, HasMin: true},
		{ID: "attachment.contentType", Max: attachment.MaxContentTypeBytes, Unit: "bytes"},
		{ID: "attachment.path", Max: attachment.MaxPathCharacters, Unit: "code points"},
		{ID: "identity.invitation.page", Max: identity.MaxPageResponseJSONBytes, Unit: "bytes"},
		{ID: "identity.pat.page", Max: identity.MaxPageResponseJSONBytes, Unit: "bytes"},
		{ID: "identity.pat.name", Max: identity.MaxPATNameCodePoints, Unit: "code points", Min: 1, HasMin: true},
		{ID: "identity.avatarUrl", Max: identity.MaxAvatarURLBytes, Unit: "bytes"},
		{ID: "identity.field", Max: identity.MaxProfileFieldBytes, Unit: "bytes"},
		{ID: "identity.profile", Max: identity.MaxProfileJSONBytes, Unit: "bytes"},
		{ID: "identity.response", Max: identity.MaxIdentityResponseBytes, Unit: "bytes"},
		{ID: "identity.upstream.timeout", Max: int64(identity.UpstreamTimeout.Seconds()), Unit: "seconds"},
		{ID: "identity.returnPath", Max: identity.MaxReturnPathBytes, Unit: "bytes"},
		{ID: "login.browser", Max: identity.MaxPendingLoginsPerBrowser, Unit: "items"},
		{ID: "login.global", Max: identity.MaxPendingLoginsGlobal, Unit: "items"},
		{ID: "login.lifetime", Max: int64(identity.LoginLifetime.Seconds()), Unit: "seconds", UpperExclusive: true},
		{ID: "project.page", Max: project.MaxPageResponseJSONBytes, Unit: "bytes"},
		{ID: "project.member.page", Max: project.MaxPageResponseJSONBytes, Unit: "bytes"},
		{ID: "project.name.bytes", Max: project.MaxNameBytes, Unit: "bytes"},
		{ID: "project.name.codePoints", Max: project.MaxNameCodePoints, Unit: "code points"},
		{ID: "project.repoUrl", Max: project.MaxRepoURLBytes, Unit: "bytes"},
		{ID: "search.expression", Max: query.MaxBytes, Unit: "bytes"},
		{ID: "search.terms", Max: query.MaxTerms, Unit: "items"},
		{ID: "search.depth", Max: query.MaxDepth, Unit: "levels"},
		{ID: "step.title", Max: text.MaxTitleBytes, Unit: "bytes"},
		{ID: "step.description", Max: text.MaxDescriptionBytes, Unit: "bytes"},
		{ID: "step.collection", Max: codec.MaxEncodedBytes, Unit: "bytes"},
		{ID: "step.mcp.cursor", Max: codec.MaxMCPStepCursorBytes, Unit: "bytes"},
		{ID: "terminal.history.cursor", Max: sessionv2.MaxHistoryCursorBytes, Unit: "bytes"},
		{ID: "task.resource", Max: task.MaxTaskResponseJSONBytes, Unit: "bytes"},
		{ID: "task.dependencies", Max: task.MaxDependencies, Unit: "items"},
		{ID: "task.description", Max: text.MaxDescriptionBytes, Unit: "bytes"},
		{ID: "task.property", Max: taskproperty.MaxValueBytes, Unit: "bytes"},
		{ID: "task.property.pullRequest.title", Max: taskproperty.MaxPullRequestTitleBytes, Unit: "bytes"},
		{ID: "task.property.pullRequest.url", Max: taskproperty.MaxPullRequestURLBytes, Unit: "bytes"},
		{ID: "task.property.worker.herdr", Max: taskproperty.MaxWorkerHerdrFieldBytes, Unit: "bytes"},
		{ID: "task.property.worker.machineName", Max: taskproperty.MaxWorkerMachineNameBytes, Unit: "bytes"},
		{ID: "task.property.worker.nativeSessionId", Max: taskproperty.MaxWorkerNativeSessionIDBytes, Unit: "bytes"},
		{ID: "task.title", Max: text.MaxTitleBytes, Unit: "bytes"},
		{ID: "team.page", Max: team.MaxPageResponseJSONBytes, Unit: "bytes"},
		{ID: "team.member.page", Max: team.MaxPageResponseJSONBytes, Unit: "bytes"},
		{ID: "team.name.bytes", Max: team.MaxNameBytes, Unit: "bytes"},
		{ID: "team.name.codePoints", Max: team.MaxNameCodePoints, Unit: "code points"},
		{ID: "thread.message", Max: codec.MessageLimit, Unit: "bytes"},
		{ID: "thread.page", Max: codec.PageLimit, Unit: "bytes"},
		{ID: "transport.rest.body", Max: transport.MaxRESTJSONBodyBytes, Unit: "bytes"},
		{ID: "transport.mcp.body", Max: transport.MaxMCPJSONBodyBytes, Unit: "bytes"},
		{ID: "transport.mcp.inputOperations", Max: transport.MaxMCPInputOperations, Unit: "items"},
		{ID: "transport.cursor", Max: transport.MaxEncodedCursorBytes, Unit: "bytes"},
		{ID: "transport.query", Max: transport.MaxRawQueryBytes, Unit: "bytes"},
		{ID: "transport.target", Max: transport.MaxRequestTargetBytes, Unit: "bytes"},
		{ID: "transport.headers", Max: transport.MaxRequestHeadersBytes, Unit: "bytes"},
		{ID: "transport.json.readTimeout", Max: int64(transport.JSONBodyReadTimeout.Seconds()), Unit: "seconds"},
		{ID: "transport.attachment.readTimeout", Max: int64(transport.AttachmentBodyReadTimeout.Seconds()), Unit: "seconds"},
		{ID: "transport.archive.readTimeout", Max: int64(transport.ArchiveBodyReadTimeout.Seconds()), Unit: "seconds"},
		{ID: "worker.active.window", Max: int64(worker.ActiveWindow.Seconds()), Unit: "seconds", Min: 0, HasMin: true, UpperExclusive: true},
		{ID: "worker.active", Max: worker.MaxActiveWorkers, Unit: "items"},
		{ID: "worker.configuration", Max: worker.MaxConfigurationJSONBytes, Unit: "bytes"},
		{ID: "worker.cpu.model", Max: worker.MaxCPUModelBytes, Unit: "bytes"},
		{ID: "worker.inventory.claims", Max: worker.MaxInventoryClaims, Unit: "items"},
		{ID: "worker.machine.name", Max: worker.MaxMachineNameBytes, Unit: "bytes"},
		{ID: "worker.maxConcurrent", Max: worker.MaxConcurrent, Unit: "value", Min: worker.MinConcurrent, HasMin: true},
		{ID: "worker.native.args", Max: worker.MaxNativeArgs, Unit: "items"},
		{ID: "worker.native.arg", Max: worker.MaxNativeArgBytes, Unit: "bytes"},
		{ID: "worker.native.model", Max: worker.MaxNativeModelBytes, Unit: "bytes"},
		{ID: "worker.observation.items", Max: worker.MaxObservationItems, Unit: "items"},
		{ID: "worker.os.arch", Max: worker.MaxOSArchBytes, Unit: "bytes"},
		{ID: "worker.os.release", Max: worker.MaxOSReleaseBytes, Unit: "bytes"},
		{ID: "worker.os.type", Max: worker.MaxOSTypeBytes, Unit: "bytes"},
		{ID: "worker.os.version", Max: worker.MaxOSVersionBytes, Unit: "bytes"},
		{ID: "worker.pollIntervalMs", Max: worker.MaxPollIntervalMs, Unit: "value", Min: worker.MinPollIntervalMs, HasMin: true},
		{ID: "worker.projects", Max: worker.MaxProjects, Unit: "items"},
		{ID: "worker.recoveryLimit", Max: worker.MaxRecoveryLimit, Unit: "value", Min: worker.MinRecoveryLimit, HasMin: true},
		{ID: "worker.resource", Max: worker.MaxWorkerJSONBytes, Unit: "bytes"},
		{ID: "worker.telemetry", Max: worker.MaxTelemetryJSONBytes, Unit: "bytes"},
		{ID: "worker.version", Max: worker.MaxVersionBytes, Unit: "bytes"},
		{ID: "worker.workingDirectory", Max: worker.MaxWorkingDirectoryBytes, Unit: "bytes"},
	}
}
