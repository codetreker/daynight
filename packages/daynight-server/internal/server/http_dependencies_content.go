package server

import (
	"context"
	"io"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
)

type attachmentOperations interface {
	List(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error)
	PutRetained(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error)
	Delete(context.Context, model.Principal, string, string, string) error
	Open(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error)
}

type botOperations interface {
	CreateResolved(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error)
	Defaults(context.Context, model.Principal, *string) (botcore.BotDefaults, error)
	List(context.Context, model.Principal, model.PageRequest) (botcore.BotPage, error)
	ListWorker(context.Context, model.Principal, string, model.PageRequest) (botcore.BotPage, error)
	Get(context.Context, model.Principal, string) (model.Bot, error)
}

type botDeletionOperations interface {
	DeleteBot(context.Context, model.Principal, string, store.DeleteBot) (model.Bot, error)
	CompleteBotDeletion(context.Context, model.Principal, string, string, botservice.BotDeletionReceipt) (model.Bot, error)
}

type botRuntimeOperations interface {
	RegisterBot(context.Context, model.Principal, string, string, sessioncore.BotRegistration) (sessioncore.BotRegistrationResult, error)
	GrantBot(context.Context, model.Principal, string, string, sessioncore.BotGrant) (sessioncore.GrantResult, error)
	ReportBot(context.Context, model.Principal, string, string, sessioncore.BotReport) (model.Bot, error)
}

type sessionInspection interface {
	Inspect(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)
}

type oauthGrantOperations interface {
	ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error)
	RevokeSessionGrant(context.Context, model.Principal, string) (bool, error)
}
