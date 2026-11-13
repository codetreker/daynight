package assistanttask

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func utc(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	result := value.UTC()
	return &result
}

func claimResponse(value model.AssistantTaskClaim) api.AssistantTaskClaim {
	return api.AssistantTaskClaim{HolderBotID: value.HolderBotID, CredentialOperationID: value.CredentialOperationID,
		Generation: value.Generation, State: value.State, ClaimedAt: utc(value.ClaimedAt), RenewedAt: utc(value.RenewedAt), LeaseUntil: utc(value.LeaseUntil), ObservedAt: value.ObservedAt.UTC()}
}
func taskResponse(value core.TaskResult) api.AssistantTask {
	task := value.Task
	return api.AssistantTask{ID: task.ID, OwnerUserID: task.OwnerUserID, Application: task.Application, Name: task.Name,
		Purpose: task.Purpose, Scope: task.Scope, Kind: task.Kind, State: task.State, Takeover: task.Takeover, Trigger: task.Trigger,
		Version: task.Version, ManualVersion: task.ManualVersion, AssistantTaskClaim: claimResponse(value.Claim), CreatedAt: task.CreatedAt.UTC(), UpdatedAt: task.UpdatedAt.UTC()}
}
func claimResultResponse(value model.AssistantTaskClaimResult) api.AssistantTaskClaimResult {
	operation := value.Operation
	return api.AssistantTaskClaimResult{Operation: api.AssistantTaskClaimOperation{OperationID: operation.OperationID,
		Kind: operation.Kind, TaskID: operation.TaskID, ActorBotID: operation.ActorBotID, RequestFingerprint: operation.RequestFingerprint,
		AdmittedAt: operation.AdmittedAt.UTC(), ResultingVersion: operation.ResultingVersion, ResultingGeneration: operation.ResultingGeneration,
		HolderBotID: operation.HolderBotID, CredentialOperationID: operation.CredentialOperationID, LeaseUntil: utc(operation.LeaseUntil)}, CurrentClaim: claimResponse(value.CurrentClaim)}
}
func manualResponse(value model.AssistantTaskManual) api.AssistantTaskManual {
	return api.AssistantTaskManual{TaskID: value.TaskID, Version: value.Version, Body: value.Body, Rules: value.Rules, Source: value.Source, ProposalID: value.ProposalID, CreatedAt: value.CreatedAt.UTC()}
}
func appendixResponse(value model.AssistantTaskAppendix) api.AssistantTaskAppendix {
	return api.AssistantTaskAppendix{ID: value.ID, TaskID: value.TaskID, Text: value.Text, SourceRecords: append([]string{}, value.SourceRecords...),
		AuthorBotID: value.AuthorBotID, State: value.State, Version: value.Version, CreatedAt: value.CreatedAt.UTC(), UpdatedAt: value.UpdatedAt.UTC()}
}
func proposalResponse(value model.AssistantTaskProposal) api.AssistantTaskProposal {
	return api.AssistantTaskProposal{ID: value.ID, TaskID: value.TaskID, BaseVersion: value.BaseVersion, Body: value.Body, Rules: value.Rules, Reason: value.Reason,
		EvidenceRecords: append([]string{}, value.EvidenceRecords...), AuthorBotID: value.AuthorBotID, Widens: value.Widens, Status: value.Status, DecisionNote: value.DecisionNote, CreatedAt: value.CreatedAt.UTC(), DecidedAt: utc(value.DecidedAt)}
}
func proposalResultResponse(value core.ProposalResult) any {
	matches := make([]api.AssistantTaskProposal, 0, len(value.RejectedMatches))
	for _, match := range value.RejectedMatches {
		matches = append(matches, proposalResponse(match))
	}
	return struct {
		Proposal        api.AssistantTaskProposal   `json:"proposal"`
		RejectedMatches []api.AssistantTaskProposal `json:"rejectedMatches"`
	}{proposalResponse(value.Proposal), matches}
}
func itemResponse(value model.AssistantTaskItem) api.AssistantTaskItem {
	return api.AssistantTaskItem{ID: value.ID, TaskID: value.TaskID, Key: value.Key, Episode: value.Episode, State: value.State, Category: value.Category,
		FollowerBotID: value.FollowerBotID, AppState: value.AppState, Version: value.Version, CreatedAt: value.CreatedAt.UTC(), UpdatedAt: value.UpdatedAt.UTC()}
}
func recordResponse(value model.AssistantTaskRecord) api.AssistantTaskRecord {
	return api.AssistantTaskRecord{ID: value.ID, TaskID: value.TaskID, ItemID: value.ItemID, Author: value.Author, AuthorBotID: value.AuthorBotID, Kind: value.Kind, Text: value.Text, Refs: value.Refs, CreatedAt: value.CreatedAt.UTC()}
}
func eventResponse(value model.AssistantTaskEvent) api.AssistantTaskEvent {
	return api.AssistantTaskEvent{ID: value.ID, TaskID: value.TaskID, TargetBotID: value.TargetBotID, Type: value.Type, Payload: value.Payload, State: value.State,
		Attention: value.Attention, CreatedAt: value.CreatedAt.UTC(), DeliveredAt: utc(value.DeliveredAt), SeenAt: utc(value.SeenAt), AckOperationID: value.AckOperationID}
}
func inquiryResponse(value model.AssistantTaskInquiry) api.AssistantTaskInquiry {
	return api.AssistantTaskInquiry{AnswerBotID: value.AnswerBotID, ID: value.ID, TaskID: value.TaskID, ItemID: value.ItemID, FromBotID: value.FromBotID, ToBotID: value.ToBotID,
		Question: value.Question, Answer: value.Answer, State: value.State, CreatedAt: value.CreatedAt.UTC(), Deadline: value.Deadline.UTC(), AnsweredAt: utc(value.AnsweredAt)}
}
func pageResponse[A, B any](page model.AssistantTaskPage[A], project func(A) B) api.AssistantTaskPage[B] {
	result := api.AssistantTaskPage[B]{Items: make([]B, 0, len(page.Items)), NextCursor: page.NextCursor, ObservedAt: page.ObservedAt.UTC()}
	for _, item := range page.Items {
		result.Items = append(result.Items, project(item))
	}
	return result
}
