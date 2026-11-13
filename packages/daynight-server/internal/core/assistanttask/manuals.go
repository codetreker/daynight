package assistanttask

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func finishWork(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, task model.AssistantTask, now time.Time) error {
	if _, err := saveTask(ctx, dao, task, fence(task, true), now); err != nil {
		return err
	}
	_, err := finish(ctx, dao, actor, task.LeaseUntil)
	return err
}
func finishUser(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, task model.AssistantTask, now time.Time) error {
	if _, err := saveTask(ctx, dao, task, store.AssistantTaskCondition{Version: task.Version}, now); err != nil {
		return err
	}
	_, err := finish(ctx, dao, actor, nil)
	return err
}
func (m *Module) AddAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input AppendixInput) (model.AssistantTaskAppendix, error) {
	var result model.AssistantTaskAppendix
	if !strictID(input.ID) || !textValid(input.Text, true) {
		return result, invalid("Appendix ID and text are required.")
	}
	task, err := m.workingTask(ctx, dao, actor, input.Mutation)
	if err != nil {
		return result, err
	}
	hash, err := fingerprint([]any{input.ID, input.TaskID, actor.BotID, input.Text, input.SourceRecords})
	if err != nil {
		return result, err
	}
	old, err := dao.Appendix(ctx, task.OwnerUserID, task.ID, input.ID)
	if err == nil {
		if err = sameRequest(old.RequestFingerprint, hash); err != nil {
			return result, err
		}
		_, err = finish(ctx, dao, actor, task.LeaseUntil)
		return old, err
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	if err = recordIDs(ctx, dao, task, input.SourceRecords); err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	result = model.AssistantTaskAppendix{ID: input.ID, TaskID: task.ID, OwnerUserID: task.OwnerUserID, Text: input.Text, State: "active", SourceRecords: input.SourceRecords, AuthorBotID: actor.BotID, Version: 1, RequestFingerprint: hash, CreatedAt: now, UpdatedAt: now}
	ok, err := dao.InsertAppendix(ctx, result)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, fault("operation_conflict", "Appendix identity already exists.")
	}
	if _, err = m.systemRecord(ctx, dao, task, "note", input.Text, nil, map[string]any{"appendixId": result.ID}, now); err != nil {
		return result, err
	}
	if _, err = m.systemEvent(ctx, dao, task, *actor.BotID, "appendix_added", map[string]any{"appendixId": result.ID}, now); err != nil {
		return result, err
	}
	return result, finishWork(ctx, dao, actor, task, now)
}
func (m *Module) UpdateAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input AppendixInput) (model.AssistantTaskAppendix, error) {
	var result model.AssistantTaskAppendix
	if actor.BotID != nil {
		return result, forbidden()
	}
	if !strictID(input.ID) || !validState(input.State, "edited", "deleted") || input.State != "deleted" && !textValid(input.Text, true) {
		return result, invalid("Appendix update is invalid.")
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	if err = expectedVersion(task, input.IfVersion); err != nil {
		return result, err
	}
	result, err = dao.Appendix(ctx, task.OwnerUserID, task.ID, input.ID)
	if err != nil {
		return result, err
	}
	if result.State == "deleted" {
		return result, model.ErrNotFound
	}
	previous := result.Version
	result.Version, err = advance(previous)
	if err != nil {
		return result, err
	}
	result.State = input.State
	if input.State == "deleted" {
		result.Text = ""
		result.SourceRecords = []string{}
	} else {
		result.Text = input.Text
		if input.SourceRecords != nil {
			if err = recordIDs(ctx, dao, task, input.SourceRecords); err != nil {
				return result, err
			}
			result.SourceRecords = input.SourceRecords
		}
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	result.UpdatedAt = now
	ok, err := dao.SaveAppendix(ctx, result, previous)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, conflict()
	}
	return result, finishUser(ctx, dao, actor, task, now)
}
func (m *Module) Propose(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input ProposalInput) (ProposalResult, error) {
	var result ProposalResult
	if !strictID(input.ID) || !textValid(input.Body, true) || !textValid(input.Reason, true) || input.BaseVersion < 1 {
		return result, invalid("Proposal identity, body, reason and base version are required.")
	}
	task, err := m.workingTask(ctx, dao, actor, input.Mutation)
	if err != nil {
		return result, err
	}
	rules, err := canonicalJSON(input.Rules)
	if err != nil {
		return result, err
	}
	hash, err := fingerprint([]any{input.ID, task.ID, actor.BotID, input.BaseVersion, input.Body, rules, input.Reason, input.EvidenceRecords})
	if err != nil {
		return result, err
	}
	old, err := dao.Proposal(ctx, task.OwnerUserID, task.ID, input.ID)
	if err == nil {
		if err = sameRequest(old.RequestFingerprint, hash); err != nil {
			return result, err
		}
		_, err = finish(ctx, dao, actor, task.LeaseUntil)
		return ProposalResult{Proposal: old, RejectedMatches: []model.AssistantTaskProposal{}}, err
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	if task.ManualVersion != input.BaseVersion {
		return result, conflict()
	}
	manual, err := dao.Manual(ctx, task.OwnerUserID, task.ID, task.ManualVersion)
	if err != nil {
		return result, err
	}
	rules, widens, err := m.rules(task.Application, manual.Rules, rules)
	if err != nil {
		return result, err
	}
	if err = recordIDs(ctx, dao, task, input.EvidenceRecords); err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	proposal := model.AssistantTaskProposal{ID: input.ID, OwnerUserID: task.OwnerUserID, TaskID: task.ID, BaseVersion: input.BaseVersion, Body: input.Body, Rules: rules, Reason: input.Reason, EvidenceRecords: input.EvidenceRecords, AuthorBotID: actor.BotID, Widens: widens, Status: "pending", RequestFingerprint: hash, CreatedAt: now}
	ok, err := dao.InsertProposal(ctx, proposal)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, fault("operation_conflict", "Proposal identity already exists.")
	}
	if _, err = m.systemEventID(ctx, dao, task, proposal.ID, *actor.BotID, "proposal_pending", map[string]any{"proposalId": proposal.ID, "widens": widens}, now); err != nil {
		return result, err
	}
	matches, err := dao.Proposals(ctx, store.AssistantTaskQuery{OwnerUserID: task.OwnerUserID, TaskID: task.ID, State: "rejected", RulesEqual: rules, Limit: 200})
	if err != nil {
		return result, err
	}
	if len(matches) > 200 {
		matches = matches[:200]
	}
	if matches == nil {
		matches = []model.AssistantTaskProposal{}
	}
	return ProposalResult{Proposal: proposal, RejectedMatches: matches}, finishWork(ctx, dao, actor, task, now)
}
func (m *Module) Decide(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input DecisionInput) (model.AssistantTaskProposal, error) {
	var result model.AssistantTaskProposal
	if actor.BotID != nil {
		return result, forbidden()
	}
	if !strictID(input.ID) || !validState(input.Decision, "approved", "edited", "rejected") || !textValid(input.Note, false) {
		return result, invalid("Proposal decision is invalid.")
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	if err = expectedVersion(task, input.IfVersion); err != nil {
		return result, err
	}
	result, err = dao.Proposal(ctx, task.OwnerUserID, task.ID, input.ID)
	if err != nil {
		return result, err
	}
	if result.Status != "pending" {
		return result, fault("invalid_transition", "The proposal has already been decided.")
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if input.Decision != "rejected" {
		if result.BaseVersion != task.ManualVersion {
			return result, conflict()
		}
		manual, err := dao.Manual(ctx, task.OwnerUserID, task.ID, task.ManualVersion)
		if err != nil {
			return result, err
		}
		if input.Body != nil {
			if input.Decision != "edited" || !textValid(*input.Body, true) {
				return result, invalid("Edited approval requires valid replacement text.")
			}
			result.Body = *input.Body
		}
		if input.Rules != nil {
			if input.Decision != "edited" {
				return result, invalid("Only an edited approval replaces rules.")
			}
			result.Rules = *input.Rules
		}
		result.Rules, result.Widens, err = m.rules(task.Application, manual.Rules, result.Rules)
		if err != nil {
			return result, err
		}
		task.ManualVersion, err = advance(task.ManualVersion)
		if err != nil {
			return result, err
		}
		if err = dao.InsertManual(ctx, model.AssistantTaskManual{OwnerUserID: task.OwnerUserID, TaskID: task.ID, Version: task.ManualVersion, Body: result.Body, Rules: result.Rules, Source: "revision", ProposalID: ptr(result.ID), CreatedAt: now}); err != nil {
			return result, err
		}
	} else if input.Body != nil || input.Rules != nil {
		return result, invalid("A rejection cannot replace the manual.")
	}
	result.Status = input.Decision
	result.DecisionNote = input.Note
	result.DecidedAt = ptr(now)
	ok, err := dao.SaveProposal(ctx, result, "pending")
	if err != nil {
		return result, err
	}
	if !ok {
		return result, conflict()
	}
	pendingEvent, err := dao.Event(ctx, task.OwnerUserID, task.ID, result.ID)
	if err != nil {
		return result, err
	}
	pendingEvent.Attention = false
	if ok, err = dao.SaveEvent(ctx, pendingEvent, pendingEvent.State); err != nil {
		return result, err
	} else if !ok {
		return result, conflict()
	}
	if task.HolderBotID != nil && !task.HolderDeleted {
		if _, err = m.systemEvent(ctx, dao, task, *task.HolderBotID, "proposal_decided", map[string]any{"proposalId": result.ID, "decision": result.Status}, now); err != nil {
			return result, err
		}
	}
	return result, finishUser(ctx, dao, actor, task, now)
}
func (m *Module) Rollback(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input RollbackInput) (model.AssistantTaskManual, error) {
	var result model.AssistantTaskManual
	if actor.BotID != nil {
		return result, forbidden()
	}
	if input.ManualVersion < 1 {
		return result, invalid("Manual version must be positive.")
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	if err = expectedVersion(task, input.IfVersion); err != nil {
		return result, err
	}
	result, err = dao.Manual(ctx, task.OwnerUserID, task.ID, input.ManualVersion)
	if err != nil {
		return result, err
	}
	current, err := dao.Manual(ctx, task.OwnerUserID, task.ID, task.ManualVersion)
	if err != nil {
		return result, err
	}
	if _, _, err = m.rules(task.Application, current.Rules, result.Rules); err != nil {
		return result, err
	}
	task.ManualVersion, err = advance(task.ManualVersion)
	if err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	result.Version = task.ManualVersion
	result.Source = "rollback"
	result.ProposalID = nil
	result.CreatedAt = now
	if err = dao.InsertManual(ctx, result); err != nil {
		return result, err
	}
	return result, finishUser(ctx, dao, actor, task, now)
}
