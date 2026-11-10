package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"testing"
)

type operationRejectedBotRuntime struct{ t *testing.T }

func (r *operationRejectedBotRuntime) RegisterBot(context.Context, model.Principal, string, string, sessioncore.BotRegistration) (sessioncore.BotRegistrationResult, error) {
	unexpectedHTTPCall(r.t, "botRuntimeOperations.RegisterBot")
	panic("unreachable")
}
func (r *operationRejectedBotRuntime) GrantBot(context.Context, model.Principal, string, string, sessioncore.BotGrant) (sessioncore.GrantResult, error) {
	unexpectedHTTPCall(r.t, "botRuntimeOperations.GrantBot")
	panic("unreachable")
}
func (r *operationRejectedBotRuntime) ReportBot(context.Context, model.Principal, string, string, sessioncore.BotReport) (model.Bot, error) {
	unexpectedHTTPCall(r.t, "botRuntimeOperations.ReportBot")
	panic("unreachable")
}

type operationRejectedInspection struct{ t *testing.T }

func (r *operationRejectedInspection) Inspect(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
	unexpectedHTTPCall(r.t, "sessionInspection.Inspect")
	panic("unreachable")
}

type operationRejectedPrompts struct{ t *testing.T }

func (r *operationRejectedPrompts) Get(context.Context, model.Principal, model.PromptScope, string) (model.PromptResource, error) {
	unexpectedHTTPCall(r.t, "promptOperations.Get")
	panic("unreachable")
}
func (r *operationRejectedPrompts) Put(context.Context, model.Principal, model.PromptScope, string, string, string, string) (model.PromptResource, error) {
	unexpectedHTTPCall(r.t, "promptOperations.Put")
	panic("unreachable")
}

type operationRejectedHistory struct{ t *testing.T }

func (r *operationRejectedHistory) Current(context.Context, model.Principal, string, string) (sp.TaskSessionCurrent, error) {
	unexpectedHTTPCall(r.t, "HistoryReader.Current")
	panic("unreachable")
}
func (r *operationRejectedHistory) List(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error) {
	unexpectedHTTPCall(r.t, "HistoryReader.List")
	panic("unreachable")
}
func (r *operationRejectedHistory) Read(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
	unexpectedHTTPCall(r.t, "HistoryReader.Read")
	panic("unreachable")
}
func (r *operationRejectedHistory) Entry(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
	unexpectedHTTPCall(r.t, "HistoryReader.Entry")
	panic("unreachable")
}
