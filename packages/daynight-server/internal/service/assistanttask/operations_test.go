package assistanttask

import (
	"context"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type operationMock struct {
	call func(context.Context, store.AssistantTaskDAO, core.Actor, string, ...any) (any, error)
}

func (m *operationMock) Create(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.CreateInput) (core.TaskResult, error) {
	value, err := m.call(ctx, dao, actor, "Create", input)
	if value == nil {
		return core.TaskResult{}, err
	}
	return value.(core.TaskResult), err
}
func (m *operationMock) Get(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string) (core.TaskResult, error) {
	value, err := m.call(ctx, dao, actor, "Get", taskID)
	if value == nil {
		return core.TaskResult{}, err
	}
	return value.(core.TaskResult), err
}
func (m *operationMock) List(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.PageInput) (model.AssistantTaskPage[core.TaskResult], error) {
	value, err := m.call(ctx, dao, actor, "List", input)
	if value == nil {
		return model.AssistantTaskPage[core.TaskResult]{}, err
	}
	return value.(model.AssistantTaskPage[core.TaskResult]), err
}
func (m *operationMock) Update(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.UpdateInput) (core.TaskResult, error) {
	value, err := m.call(ctx, dao, actor, "Update", input)
	if value == nil {
		return core.TaskResult{}, err
	}
	return value.(core.TaskResult), err
}
func (m *operationMock) Claim(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.ClaimInput) (model.AssistantTaskClaimResult, error) {
	value, err := m.call(ctx, dao, actor, "Claim", input)
	if value == nil {
		return model.AssistantTaskClaimResult{}, err
	}
	return value.(model.AssistantTaskClaimResult), err
}
func (m *operationMock) ClaimOperation(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID, operationID string) (model.AssistantTaskClaimResult, error) {
	value, err := m.call(ctx, dao, actor, "ClaimOperation", taskID, operationID)
	if value == nil {
		return model.AssistantTaskClaimResult{}, err
	}
	return value.(model.AssistantTaskClaimResult), err
}
func (m *operationMock) GetManual(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, version int64) (model.AssistantTaskManual, error) {
	value, err := m.call(ctx, dao, actor, "GetManual", taskID, version)
	if value == nil {
		return model.AssistantTaskManual{}, err
	}
	return value.(model.AssistantTaskManual), err
}
func (m *operationMock) ListManuals(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskManual], error) {
	value, err := m.call(ctx, dao, actor, "ListManuals", taskID, input)
	if value == nil {
		return model.AssistantTaskPage[model.AssistantTaskManual]{}, err
	}
	return value.(model.AssistantTaskPage[model.AssistantTaskManual]), err
}
func (m *operationMock) ListAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskAppendix], error) {
	value, err := m.call(ctx, dao, actor, "ListAppendix", taskID, input)
	if value == nil {
		return model.AssistantTaskPage[model.AssistantTaskAppendix]{}, err
	}
	return value.(model.AssistantTaskPage[model.AssistantTaskAppendix]), err
}
func (m *operationMock) AddAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error) {
	value, err := m.call(ctx, dao, actor, "AddAppendix", input)
	if value == nil {
		return model.AssistantTaskAppendix{}, err
	}
	return value.(model.AssistantTaskAppendix), err
}
func (m *operationMock) UpdateAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error) {
	value, err := m.call(ctx, dao, actor, "UpdateAppendix", input)
	if value == nil {
		return model.AssistantTaskAppendix{}, err
	}
	return value.(model.AssistantTaskAppendix), err
}
func (m *operationMock) ListProposals(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskProposal], error) {
	value, err := m.call(ctx, dao, actor, "ListProposals", taskID, input)
	if value == nil {
		return model.AssistantTaskPage[model.AssistantTaskProposal]{}, err
	}
	return value.(model.AssistantTaskPage[model.AssistantTaskProposal]), err
}
func (m *operationMock) Propose(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.ProposalInput) (core.ProposalResult, error) {
	value, err := m.call(ctx, dao, actor, "Propose", input)
	if value == nil {
		return core.ProposalResult{}, err
	}
	return value.(core.ProposalResult), err
}
func (m *operationMock) Decide(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.DecisionInput) (model.AssistantTaskProposal, error) {
	value, err := m.call(ctx, dao, actor, "Decide", input)
	if value == nil {
		return model.AssistantTaskProposal{}, err
	}
	return value.(model.AssistantTaskProposal), err
}
func (m *operationMock) Rollback(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.RollbackInput) (model.AssistantTaskManual, error) {
	value, err := m.call(ctx, dao, actor, "Rollback", input)
	if value == nil {
		return model.AssistantTaskManual{}, err
	}
	return value.(model.AssistantTaskManual), err
}
func (m *operationMock) ListItems(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskItem], error) {
	value, err := m.call(ctx, dao, actor, "ListItems", taskID, input)
	if value == nil {
		return model.AssistantTaskPage[model.AssistantTaskItem]{}, err
	}
	return value.(model.AssistantTaskPage[model.AssistantTaskItem]), err
}
func (m *operationMock) GetItem(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID, id string) (model.AssistantTaskItem, error) {
	value, err := m.call(ctx, dao, actor, "GetItem", taskID, id)
	if value == nil {
		return model.AssistantTaskItem{}, err
	}
	return value.(model.AssistantTaskItem), err
}
func (m *operationMock) SaveItem(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.ItemInput) (model.AssistantTaskItem, error) {
	value, err := m.call(ctx, dao, actor, "SaveItem", input)
	if value == nil {
		return model.AssistantTaskItem{}, err
	}
	return value.(model.AssistantTaskItem), err
}
func (m *operationMock) ListRecords(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskRecord], error) {
	value, err := m.call(ctx, dao, actor, "ListRecords", taskID, input)
	if value == nil {
		return model.AssistantTaskPage[model.AssistantTaskRecord]{}, err
	}
	return value.(model.AssistantTaskPage[model.AssistantTaskRecord]), err
}
func (m *operationMock) AddRecord(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.RecordInput) (model.AssistantTaskRecord, error) {
	value, err := m.call(ctx, dao, actor, "AddRecord", input)
	if value == nil {
		return model.AssistantTaskRecord{}, err
	}
	return value.(model.AssistantTaskRecord), err
}
func (m *operationMock) ListEvents(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskEvent], error) {
	value, err := m.call(ctx, dao, actor, "ListEvents", taskID, input)
	if value == nil {
		return model.AssistantTaskPage[model.AssistantTaskEvent]{}, err
	}
	return value.(model.AssistantTaskPage[model.AssistantTaskEvent]), err
}
func (m *operationMock) AddEvent(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.EventInput) (model.AssistantTaskEvent, error) {
	value, err := m.call(ctx, dao, actor, "AddEvent", input)
	if value == nil {
		return model.AssistantTaskEvent{}, err
	}
	return value.(model.AssistantTaskEvent), err
}
func (m *operationMock) AckEvent(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AckEventInput) (model.AssistantTaskEvent, error) {
	value, err := m.call(ctx, dao, actor, "AckEvent", input)
	if value == nil {
		return model.AssistantTaskEvent{}, err
	}
	return value.(model.AssistantTaskEvent), err
}
func (m *operationMock) ListInquiries(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskInquiry], error) {
	value, err := m.call(ctx, dao, actor, "ListInquiries", taskID, input)
	if value == nil {
		return model.AssistantTaskPage[model.AssistantTaskInquiry]{}, err
	}
	return value.(model.AssistantTaskPage[model.AssistantTaskInquiry]), err
}
func (m *operationMock) Ask(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.InquiryInput) (model.AssistantTaskInquiry, error) {
	value, err := m.call(ctx, dao, actor, "Ask", input)
	if value == nil {
		return model.AssistantTaskInquiry{}, err
	}
	return value.(model.AssistantTaskInquiry), err
}
func (m *operationMock) Answer(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AnswerInput) (model.AssistantTaskInquiry, error) {
	value, err := m.call(ctx, dao, actor, "Answer", input)
	if value == nil {
		return model.AssistantTaskInquiry{}, err
	}
	return value.(model.AssistantTaskInquiry), err
}
func (m *operationMock) ClearAttention(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, target string) error {
	_, err := m.call(ctx, dao, actor, "ClearAttention", target)
	return err
}

func (m *operationMock) EnablePreset(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.CreateInput, target string) (core.TaskResult, error) {
	value, err := m.call(ctx, dao, actor, "EnablePreset", input, target)
	if value == nil {
		return core.TaskResult{}, err
	}
	return value.(core.TaskResult), err
}
