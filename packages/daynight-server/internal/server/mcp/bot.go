package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	modellimit "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed bot_tools.json
var botToolsJSON []byte

type botOperations interface {
	CreateResolved(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error)
	Get(context.Context, model.Principal, string) (model.Bot, error)
	ListAdmitted(context.Context, model.Principal, *string, model.PageRequest, func([]model.Bot, *string) error) (botcore.BotPage, error)
}
type botDeletion interface {
	DeleteBot(context.Context, model.Principal, string, store.DeleteBot) (model.Bot, error)
}
type botTools struct {
	bots  botOperations
	relay botDeletion
}
type botListInput struct {
	Limit  *int    `json:"limit"`
	Cursor *string `json:"cursor"`
}
type botShowInput struct {
	BotID string `json:"botId"`
}
type botCreateInput struct {
	Name            string  `json:"name"`
	WorkerID        *string `json:"workerId"`
	Cwd             *string `json:"cwd"`
	Agent           *string `json:"agent"`
	Model           *string `json:"model"`
	ReasoningEffort *string `json:"reasoningEffort"`
	RequestID       *string `json:"requestId"`
}
type botDeleteInput struct {
	BotID     string  `json:"botId"`
	IfVersion string  `json:"ifVersion"`
	RequestID *string `json:"requestId"`
}

// RegisterBotTools uses the same Bot use cases and deletion barrier as REST.
func RegisterBotTools(e *Entry, bots botOperations, relay botDeletion) error {
	var tools []*sdk.Tool
	if err := json.Unmarshal(botToolsJSON, &tools); err != nil {
		return fmt.Errorf("decode Bot tools: %w", err)
	}
	byName := make(map[string]*sdk.Tool, len(tools))
	for _, tool := range tools {
		byName[tool.Name] = tool
	}
	h := &botTools{bots: bots, relay: relay}
	if err := registerTypedReadTool(e, byName["bot_list"], BudgetLarge, h.list, "cursor"); err != nil {
		return err
	}
	if err := registerTypedReadTool(e, byName["bot_show"], BudgetLarge, h.show, "botId"); err != nil {
		return err
	}
	if err := RegisterTypedTool(e, byName["bot_create"], BudgetLarge, h.create, "name", "workerId", "cwd", "agent", "model", "reasoningEffort", "requestId"); err != nil {
		return err
	}
	return RegisterTypedTool(e, byName["bot_delete"], BudgetLarge, h.delete, "botId", "ifVersion", "requestId")
}

type botPage struct {
	Items      []api.Bot `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

func (h *botTools) list(ctx context.Context, actor RequestActor, in botListInput) (ToolResult, error) {
	limit := 50
	if in.Limit != nil {
		limit = *in.Limit
	}
	project := func(items []model.Bot, cursor *string) botPage {
		out := botPage{Items: make([]api.Bot, 0, len(items)), NextCursor: cursor}
		for _, item := range items {
			out.Items = append(out.Items, bothttp.Response(item))
		}
		return out
	}
	page, err := h.bots.ListAdmitted(ctx, actor.Principal, nil, model.PageRequest{Limit: limit, Cursor: in.Cursor}, func(items []model.Bot, cursor *string) error {
		raw, err := json.Marshal(envelope{Data: project(items, cursor), Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil {
			return err
		}
		if len(raw) > botcore.MaxCandidatePageResponseJSONBytes {
			return &modellimit.Violation{Field: "bot.page", Actual: int64(len(raw)), Max: botcore.MaxCandidatePageResponseJSONBytes, Unit: "bytes"}
		}
		return nil
	})
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{Data: project(page.Items, page.NextCursor)}, nil

}
func (h *botTools) show(ctx context.Context, actor RequestActor, in botShowInput) (ToolResult, error) {
	bot, err := h.bots.Get(ctx, actor.Principal, in.BotID)
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{Data: bothttp.Response(bot)}, nil
}
func operationID(requestID *string) (string, error) {
	if requestID != nil {
		return model.CanonicalID(*requestID)
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}
func (h *botTools) create(ctx context.Context, actor RequestActor, in botCreateInput) (ToolResult, error) {
	id, err := operationID(in.RequestID)
	if err != nil {
		return ToolResult{}, err
	}
	refs := map[string]any{"botId": id}
	overrides := model.BotOverrides{WorkerID: in.WorkerID, Cwd: in.Cwd, Provider: in.Agent, Model: in.Model, ReasoningEffort: in.ReasoningEffort}
	if botCreateBodySize(id, in.Name, overrides) > httpx.MaxJSONBody {
		return ToolResult{Refs: refs}, &model.Fault{Code: "invalid_input", Message: "Bot creation input exceeds the JSON body limit."}
	}
	bot, err := h.bots.CreateResolved(ctx, actor.Principal, botcore.CreateBot{ID: id, Name: in.Name, Overrides: overrides})
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	return ToolResult{Data: bothttp.Response(bot), WriteOutcome: "confirmed", Refs: refs}, nil
}

// botCreateBodySize measures the REST JSON body as JSON.stringify encodes it.
func botCreateBodySize(id, name string, overrides model.BotOverrides) int {
	stringSize := func(value string) int {
		size := 2
		for i := 0; i < len(value); i++ {
			switch value[i] {
			case '"', '\\', '\b', '\f', '\n', '\r', '\t':
				size += 2
			default:
				if value[i] < 0x20 {
					size += 6
				} else {
					size++
				}
			}
		}
		return size
	}
	size := len(`{"id":,"name":}`) + stringSize(id) + stringSize(name)
	if overrides.WorkerID != nil || overrides.Cwd != nil || overrides.Provider != nil || overrides.Model != nil || overrides.ReasoningEffort != nil {
		size += len(`,"overrides":{}`)
		first := true
		for _, field := range []struct {
			name  string
			value *string
		}{
			{"workerId", overrides.WorkerID}, {"cwd", overrides.Cwd}, {"provider", overrides.Provider}, {"model", overrides.Model}, {"reasoningEffort", overrides.ReasoningEffort},
		} {
			if field.value == nil {
				continue
			}
			if !first {
				size++
			}
			first = false
			size += stringSize(field.name) + 1 + stringSize(*field.value)
		}
	}
	return size
}

func (h *botTools) delete(ctx context.Context, actor RequestActor, in botDeleteInput) (ToolResult, error) {
	botID, err := model.CanonicalID(in.BotID)
	if err != nil {
		return ToolResult{}, err
	}
	version, err := ParseVersion(in.IfVersion)
	if err != nil {
		return ToolResult{Refs: map[string]any{"botId": botID}}, err
	}
	id, err := operationID(in.RequestID)
	if err != nil {
		return ToolResult{Refs: map[string]any{"botId": botID}}, err
	}
	refs := map[string]any{"botId": botID, "deletionId": id}
	bot, err := h.relay.DeleteBot(ctx, actor.Principal, botID, store.DeleteBot{Version: version, DeletionID: id})
	if err != nil {
		var cleanup *botservice.DeletionCleanupError
		if errors.As(err, &cleanup) {
			return ToolResult{Refs: refs, WriteOutcome: "confirmed", Phase: "cleanup"}, err
		}
		return ToolResult{Refs: refs}, err
	}
	return ToolResult{Data: bothttp.Response(bot), WriteOutcome: "confirmed", Refs: refs}, nil
}
