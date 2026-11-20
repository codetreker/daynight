package scopepolicy

import (
	"errors"
	"fmt"
	"slices"
)

var ErrInsufficientScope = errors.New("insufficient_scope")

// Policy is an explicit, immutable snapshot. Fixed-profile credentials are
// represented separately by their existing authentication paths, not by an
// empty or unrestricted Policy.
type Policy struct {
	kind    CredentialType
	scopes  []ScopeID
	version int64
}

// NewPolicy validates a persisted policy, including its canonical ordering.
// Corrupt or absent data must not be interpreted as unrestricted access.
func NewPolicy(kind CredentialType, ids []ScopeID, version int64) (Policy, error) {
	if version < 1 {
		return Policy{}, fmt.Errorf("invalid scope version")
	}
	normalized, err := Normalize(kind, ids)
	if err != nil {
		return Policy{}, err
	}
	if !slices.Equal(ids, normalized) {
		return Policy{}, fmt.Errorf("scopes are not canonical")
	}
	return Policy{kind: kind, scopes: normalized, version: version}, nil
}

func (p Policy) Kind() CredentialType { return p.kind }
func (p Policy) Version() int64       { return p.version }
func (p Policy) Scopes() []ScopeID    { return slices.Clone(p.scopes) }

// Require checks all requirements before the caller starts the business action.
// It does not decide the caller's existing role or resource access.
func (p Policy) Require(required ...ScopeID) error {
	if p.version < 1 || (p.kind != PAT && p.kind != MCP) || len(required) == 0 {
		return fmt.Errorf("invalid policy or empty requirement")
	}
	for _, id := range required {
		if !slices.Contains(p.scopes, id) {
			return fmt.Errorf("%w: %s", ErrInsufficientScope, id)
		}
	}
	return nil
}

// Operation names a shared business operation, independent of REST or MCP.
// Dynamic operations combine the requirements for their actual fields.
type Operation string

const (
	TaskRead                Operation = "task.read"
	TaskWrite               Operation = "task.write"
	TaskAssign              Operation = "task.assign"
	TaskDependencies        Operation = "task.dependencies"
	TaskStatus              Operation = "task.status"
	TaskDelete              Operation = "task.delete"
	StepRead                Operation = "step.read"
	StepWrite               Operation = "step.write"
	ThreadRead              Operation = "thread.read"
	ThreadPost              Operation = "thread.post"
	AttachmentRead          Operation = "attachment.read"
	AttachmentUpload        Operation = "attachment.upload"
	AttachmentDelete        Operation = "attachment.delete"
	AgentAuthorize          Operation = "agent.authorize"
	WorkerClaim             Operation = "worker.claim"
	WorkerRelease           Operation = "worker.release"
	WorkerComplete          Operation = "worker.complete"
	WorkerRetry             Operation = "worker.retry"
	WorkerRecover           Operation = "worker.recover"
	WorkerReport            Operation = "worker.report"
	WorkerRead              Operation = "worker.read"
	WorkerConfigure         Operation = "worker.configure"
	WorkerInspect           Operation = "worker.inspect"
	SessionRead             Operation = "session.read"
	SessionSend             Operation = "session.send"
	SessionControl          Operation = "session.control"
	SessionProduce          Operation = "session.produce"
	SessionDelete           Operation = "session.delete"
	ProjectRead             Operation = "project.read"
	ProjectWrite            Operation = "project.write"
	ProjectMembers          Operation = "project.members"
	ProjectInvitations      Operation = "project.invitations"
	ProjectInvitationRead   Operation = "project.invitation-read"
	ProjectInvitationAccept Operation = "project.invitation-accept"
	ProjectRepository       Operation = "project.repository"
	ProjectTransfer         Operation = "project.transfer"
	ProjectDelete           Operation = "project.delete"
	TeamRead                Operation = "team.read"
	TeamWrite               Operation = "team.write"
	TeamMembers             Operation = "team.members"
	TeamInvitations         Operation = "team.invitations"
	TeamInvitationRead      Operation = "team.invitation-read"
	TeamInvitationAccept    Operation = "team.invitation-accept"
	TeamLeave               Operation = "team.leave"
	TeamDelete              Operation = "team.delete"
	TagRead                 Operation = "tag.read"
	TagWrite                Operation = "tag.write"
	TagDelete               Operation = "tag.delete"
	BotRead                 Operation = "bot.read"
	BotWrite                Operation = "bot.write"
	BotDelete               Operation = "bot.delete"
	AssistantTaskRead       Operation = "assistant-task.read"
	AssistantTaskWrite      Operation = "assistant-task.write"
	AssistantTaskOperate    Operation = "assistant-task.operate"
	AssistantTaskDelete     Operation = "assistant-task.delete"
	AssistantTaskInbox      Operation = "assistant-task.inbox"
	WebhookRead             Operation = "webhook.read"
	WebhookWrite            Operation = "webhook.write"
	WebhookDelete           Operation = "webhook.delete"
	WebhookSecret           Operation = "webhook.secret"
	WebhookDeliver          Operation = "webhook.deliver"
	AccountWrite            Operation = "account.write"
	PromptRead              Operation = "prompt.read"
	PromptWrite             Operation = "prompt.write"
	UsageRead               Operation = "usage.read"
	GithubRead              Operation = "github.read"
	GithubManage            Operation = "github.manage"
)

// Requirements rejects unknown operations instead of treating them as public.
func Requirements(operations ...Operation) ([]ScopeID, error) {
	if len(operations) == 0 {
		return nil, fmt.Errorf("no operations")
	}
	mapped := map[Operation]ScopeID{
		TaskRead:                "task:read",
		TaskWrite:               "task:write",
		TaskAssign:              "task:assign",
		TaskDependencies:        "task:dependencies",
		TaskStatus:              "task:status",
		TaskDelete:              "task:delete",
		StepRead:                "step:read",
		StepWrite:               "step:write",
		ThreadRead:              "thread:read",
		ThreadPost:              "thread:post",
		AttachmentRead:          "attachment:read",
		AttachmentUpload:        "attachment:upload",
		AttachmentDelete:        "attachment:delete",
		AgentAuthorize:          "agent:authorize",
		WorkerClaim:             "worker:claim",
		WorkerRelease:           "worker:release",
		WorkerComplete:          "worker:complete",
		WorkerRetry:             "worker:retry",
		WorkerRecover:           "worker:recover",
		WorkerReport:            "worker:report",
		WorkerRead:              "worker:read",
		WorkerConfigure:         "worker:configure",
		WorkerInspect:           "worker:inspect",
		SessionRead:             "session:read",
		SessionSend:             "session:send",
		SessionControl:          "session:control",
		SessionProduce:          "session:produce",
		SessionDelete:           "session:delete",
		ProjectRead:             "project:read",
		ProjectWrite:            "project:write",
		ProjectMembers:          "project:members",
		ProjectInvitations:      "project:invitations",
		ProjectInvitationRead:   "project:invitation-read",
		ProjectInvitationAccept: "project:invitation-accept",
		ProjectRepository:       "project:repository",
		ProjectTransfer:         "project:transfer",
		ProjectDelete:           "project:delete",
		TeamRead:                "team:read",
		TeamWrite:               "team:write",
		TeamMembers:             "team:members",
		TeamInvitations:         "team:invitations",
		TeamInvitationRead:      "team:invitation-read",
		TeamInvitationAccept:    "team:invitation-accept",
		TeamLeave:               "team:leave",
		TeamDelete:              "team:delete",
		TagRead:                 "tag:read",
		TagWrite:                "tag:write",
		TagDelete:               "tag:delete",
		BotRead:                 "bot:read",
		BotWrite:                "bot:write",
		BotDelete:               "bot:delete",
		AssistantTaskRead:       "assistant-task:read",
		AssistantTaskWrite:      "assistant-task:write",
		AssistantTaskOperate:    "assistant-task:operate",
		AssistantTaskDelete:     "assistant-task:delete",
		AssistantTaskInbox:      "assistant-task:inbox",
		WebhookRead:             "webhook:read",
		WebhookWrite:            "webhook:write",
		WebhookDelete:           "webhook:delete",
		WebhookSecret:           "webhook:secret",
		WebhookDeliver:          "webhook:deliver",
		AccountWrite:            "account:write",
		PromptRead:              "prompt:read",
		PromptWrite:             "prompt:write",
		UsageRead:               "usage:read",
		GithubRead:              "github:read",
		GithubManage:            "github:manage",
	}
	seen := map[ScopeID]bool{}
	result := make([]ScopeID, 0, len(operations))
	for _, op := range operations {
		id, ok := mapped[op]
		if !ok {
			return nil, fmt.Errorf("unknown operation %q", op)
		}
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	slices.Sort(result)
	return result, nil
}
