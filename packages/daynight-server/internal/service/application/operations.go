package application

import (
	"context"
	"io"
	"net/url"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	taskwork "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

// IdentityOperations is the identity output consumed by protocol adapters.
type IdentityOperations interface {
	CallbackURL() string
	ValidateLogin(string, string) error
	StartLogin(context.Context, string, string, string) (identitycore.LoginStart, error)
	CompleteLogin(context.Context, url.Values, string) (identitycore.LoginCompletion, error)
	Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error)
	User(context.Context, model.Principal) (model.User, error)
	Logout(context.Context, model.Principal) error
	CreatePAT(context.Context, model.Principal, identitycore.CreatePAT) (identitycore.MintedPAT, error)
	ListPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error)
	RevokePAT(context.Context, model.Principal, string) error
	UpdatePATExpiry(context.Context, model.Principal, string, identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error)
	Providers(context.Context) ([]string, error)
	StartDevice(context.Context, string, string) (identitycore.DeviceStart, error)
	InspectDevice(context.Context, model.Principal, string) (identitycore.DeviceInspection, error)
	DecideDevice(context.Context, model.Principal, string, string, string) error
	RedeemDevice(context.Context, string, string, string, string) (identitycore.MintedPAT, error)
	LogoutDevice(context.Context, model.Principal) error
	PersonalTeamID(context.Context, model.Principal) (string, error)
}

// TaskObservationOperations is the observation output consumed by protocol adapters.
type TaskObservationOperations interface {
	ObserveGet(context.Context, model.Principal, string, string) (task.ObservedTask, error)
	ObserveList(context.Context, model.Principal, string, task.TaskListRequest) (task.ObservedTaskPage, error)
	ObserveGraph(context.Context, model.Principal, string, string) (task.ObservedGraph, error)
	ObservedMCPList(context.Context, model.Principal, string, taskcore.MCPListRequest) (task.ObservedMCPPage, error)
	WorkList(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error)
}

// TaskStepsOperations is the task step output consumed by protocol adapters.
type TaskStepsOperations interface {
	ListPage(context.Context, model.Principal, string, string, int64, int, *int64, bool) (task.StepsPage, error)
	GetSummary(context.Context, model.Principal, string, string, string) (task.StepSummary, error)
	List(context.Context, model.Principal, string, string) (task.StepsDocument, error)
	Get(context.Context, model.Principal, string, string, string) (task.StepDocument, error)
	Add(context.Context, model.Principal, string, string, task.AddTaskStep) (task.StepsWriteResult, error)
	Update(context.Context, model.Principal, string, string, string, task.UpdateTaskStep) (task.StepsWriteResult, error)
	SetStatus(context.Context, model.Principal, string, string, string, task.SetTaskStepStatus) (task.StepsWriteResult, error)
	Move(context.Context, model.Principal, string, string, string, task.MoveTaskStep) (task.StepsWriteResult, error)
	Delete(context.Context, model.Principal, string, string, string, task.DeleteTaskStep) (task.StepsWriteResult, error)
}

// ProjectOperations is the project output shared by HTTP and MCP adapters.
type ProjectOperations interface {
	CreateWithAccess(context.Context, model.Principal, projectcore.CreateProject) (model.Project, model.ProjectAccess, error)
	GetWithAccess(context.Context, model.Principal, string) (model.Project, model.ProjectAccess, error)
	ListScoped(context.Context, model.Principal, projectcore.ProjectListRequest) (projectcore.ProjectPage, error)
	Access(context.Context, model.Principal, string) (model.ProjectAccess, error)
	UpdateSettings(context.Context, model.Principal, string, projectcore.UpdateProjectSettings) (model.Project, error)
	TransferPreview(context.Context, model.Principal, string, string) (projectcore.TransferPreview, error)
	Transfer(context.Context, model.Principal, string, projectcore.TransferInput) (projectcore.TransferReceipt, error)
	DeletionPreview(context.Context, model.Principal, string, model.PageRequest) (project.DeletionPreview, error)
	Delete(context.Context, model.Principal, string) (project.DeletionReceipt, error)
	RegisterRepository(context.Context, model.Principal, projectcore.CreateProject, bool) (model.Project, bool, error)
	ResolveRepository(context.Context, model.Principal, string) (model.Project, error)
	Get(context.Context, model.Principal, string) (model.Project, error)
}

// MembershipOperations keeps project membership separate from project operations.
type MembershipOperations interface {
	ListWithAccess(context.Context, model.Principal, string) (projectcore.ProjectParticipants, error)
	SetRole(context.Context, model.Principal, string, string, projectcore.SetProjectMemberRole) (model.ProjectGrant, error)
	Remove(context.Context, model.Principal, string, string, projectcore.RemoveProjectMember) error
	SetGrant(context.Context, model.Principal, string, string, projectcore.SetProjectGrant) (projectcore.SetGrantResult, error)
	RemoveGrant(context.Context, model.Principal, string, string, projectcore.RemoveProjectMember) (projectcore.RemoveGrantResult, error)
	CreateInvitation(context.Context, model.Principal, string, string) (projectcore.MintedInvitation, error)
	ListInvitations(context.Context, model.Principal, string) ([]model.ProjectInvitation, error)
	RevokeInvitation(context.Context, model.Principal, string, string, string) error
	InspectInvitation(context.Context, model.Principal, string) (projectcore.InvitationInspection, error)
	AcceptInvitation(context.Context, model.Principal, string, string) (projectcore.InvitationAcceptance, error)
}

// TeamOperations is the team output shared by HTTP and MCP adapters.
type TeamOperations interface {
	Create(context.Context, model.Principal, teamcore.CreateTeam) (model.Team, error)
	Get(context.Context, model.Principal, string) (model.Team, error)
	List(context.Context, model.Principal, model.PageRequest) (teamcore.TeamPage, error)
	Rename(context.Context, model.Principal, string, teamcore.ChangeTeam) (model.Team, error)
	Delete(context.Context, model.Principal, string, teamcore.ChangeTeam) error
	Members(context.Context, model.Principal, string) ([]model.TeamMemberProfile, error)
	MembersPage(context.Context, model.Principal, string, model.PageRequest) (teamcore.MemberPage, error)
	Member(context.Context, model.Principal, string, string) (model.TeamMember, error)
	SetMemberRole(context.Context, model.Principal, string, string, teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error)
	RemoveMember(context.Context, model.Principal, string, string, teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error)
	CreateInvitation(context.Context, model.Principal, string, string) (teamcore.MintedTeamInvitation, error)
	ListInvitations(context.Context, model.Principal, string) ([]model.TeamInvitation, error)
	ListInvitationPage(context.Context, model.Principal, string, model.PageRequest) (teamcore.InvitationPage, error)
	RevokeInvitation(context.Context, model.Principal, string, string, string) (bool, error)
	InspectInvitation(context.Context, model.Principal, string) (teamcore.TeamInvitationInspection, error)
	AcceptInvitation(context.Context, model.Principal, string, string) (teamcore.TeamInvitationAcceptance, error)
}

// BotOperations is the bot definition output shared by HTTP and MCP adapters.
type BotOperations interface {
	CreateResolved(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error)
	Defaults(context.Context, model.Principal, *string) (botcore.BotDefaults, error)
	List(context.Context, model.Principal, model.PageRequest) (botcore.BotPage, error)
	ListWorker(context.Context, model.Principal, string, model.PageRequest) (botcore.BotPage, error)
	Get(context.Context, model.Principal, string) (model.Bot, error)
}

// BotDeletionOperations retains both deletion admission and cleanup completion.
type BotDeletionOperations interface {
	DeleteBot(context.Context, model.Principal, string, store.DeleteBot) (model.Bot, error)
	CompleteBotDeletion(context.Context, model.Principal, string, string, bot.BotDeletionReceipt) (model.Bot, error)
}

// TaskOperations is the task output shared by HTTP and MCP adapters.
type TaskOperations interface {
	Create(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error)
	Update(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error)
	Delete(context.Context, model.Principal, string, string, taskcore.DeleteTask) error
	SetStatus(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error)
	Get(context.Context, model.Principal, string, string) (model.Task, error)
	Observe(context.Context, model.Principal, string, string) (task.TaskObservation, error)
	List(context.Context, model.Principal, string, task.TaskListRequest) (task.TaskPage, error)
	Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error)
	Assignees(context.Context, model.Principal, string, task.TaskAssigneesRequest) (model.TaskAssignees, error)
	SetProperty(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error)
	RemoveProperty(context.Context, model.Principal, string, string, string, int64) (model.Task, error)
	ClaimWorker(context.Context, model.Principal, string, string, taskcore.ClaimWorker) (model.Task, error)
	UpdateWorker(context.Context, model.Principal, string, string, taskcore.UpdateWorker) (model.Task, error)
	ReleaseWorker(context.Context, model.Principal, string, string, taskcore.ReleaseWorker) (model.Task, error)
	WithdrawWorker(context.Context, model.Principal, string, string, taskcore.WithdrawWorker) (model.Task, error)
	ResumeWorker(context.Context, model.Principal, string, string, taskcore.ResumeWorker) (model.Task, error)
	UpdatePartitionedDependencies(context.Context, model.Principal, string, string, taskcore.UpdateTask, *[]string, *[]string) (model.Task, error)
	MCPReady(context.Context, model.Principal, string, taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error)
}

// TaskThreadOperations is the thread output shared by HTTP and MCP adapters.
type TaskThreadOperations interface {
	Post(context.Context, model.Principal, string, string, task.CreateThreadMessage) (task.ThreadMessageDocument, error)
	List(context.Context, model.Principal, string, string, task.ThreadListRequest) (task.ThreadPageDocument, error)
}

// AttachmentOperations also supplies the retained sources used by private transfers.
type AttachmentOperations interface {
	List(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error)
	PutRetained(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error)
	Delete(context.Context, model.Principal, string, string, string) error
	Open(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error)
	Put(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, error)
	AdmitTransfer(context.Context, model.Principal, string, string, string, string, filestorage.TransferNamespace) (*attachment.TransferAdmission, error)
	AcquireUploadLease(context.Context, model.Principal, string, string) (io.Closer, error)
}

// DownloadOperations keeps content admission inside the download use case.
type DownloadOperations interface {
	Read(context.Context, mcptransfer.Actor, mcpdownload.Input) (map[string]any, error)
	ReadAdmitted(context.Context, mcptransfer.Actor, mcpdownload.Input, func(context.Context) error) (map[string]any, error)
}

// UploadOperations executes one private upload action.
type UploadOperations interface {
	Execute(context.Context, transfercore.Actor, string, string, mcptransfer.UploadInput) (map[string]any, error)
}

// OAuthOperations authenticates access credentials for the MCP resource.
type OAuthOperations interface {
	AuthenticateAccess(context.Context, string, string) (store.OAuthAccessIdentity, error)
}

var (
	_ ProjectOperations     = (*project.Projects)(nil)
	_ MembershipOperations  = (*project.Memberships)(nil)
	_ TeamOperations        = (*team.Teams)(nil)
	_ BotOperations         = (*bot.Bots)(nil)
	_ BotDeletionOperations = (*bot.Deletions)(nil)
	_ TaskOperations        = (*task.Tasks)(nil)
	_ TaskThreadOperations  = (*task.TaskThreads)(nil)
	_ AttachmentOperations  = (*attachment.Attachments)(nil)
	_ DownloadOperations    = (*mcpdownload.Service)(nil)
	_ UploadOperations      = (*mcptransfer.Uploads)(nil)
	_ OAuthOperations       = (*oauth.Authenticator)(nil)
)
