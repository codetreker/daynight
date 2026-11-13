package assistanttask

import (
	"encoding/json"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type Actor struct {
	Principal model.Principal
	BotID     *string
}
type TaskResult struct {
	Task  model.AssistantTask
	Claim model.AssistantTaskClaim
}
type PageInput struct {
	Limit                              int
	Cursor, State, ItemID, TargetBotID string
}
type CreateInput struct {
	ID, Name, Purpose, Scope, Kind, Takeover, Application string
	Trigger                                               json.RawMessage
	Body                                                  string
	Rules                                                 json.RawMessage
}
type ClaimInput struct {
	TaskID, OperationID, Kind, ClaimToken string
	TargetBotID                           *string
	IfVersion                             *int64
	ExpectedGeneration                    int64
}
type Mutation struct {
	TaskID, ID, ClaimToken     string
	IfVersion, ClaimGeneration int64
}
type UpdateInput struct {
	TaskID                                string
	IfVersion                             int64
	Name, Purpose, Scope, Takeover, State *string
	Trigger                               *json.RawMessage
}
type AppendixInput struct {
	Mutation
	Text          string
	SourceRecords []string
	State         string
}
type ProposalInput struct {
	Mutation
	BaseVersion     int64
	Body, Reason    string
	Rules           json.RawMessage
	EvidenceRecords []string
}
type ProposalResult struct {
	Proposal        model.AssistantTaskProposal
	RejectedMatches []model.AssistantTaskProposal
}
type DecisionInput struct {
	TaskID, ID, Decision, Note string
	IfVersion                  int64
	Body                       *string
	Rules                      *json.RawMessage
}
type RollbackInput struct {
	TaskID                   string
	IfVersion, ManualVersion int64
}
type ItemInput struct {
	Mutation
	Key, State, Category string
	Episode              int64
	ItemVersion          *int64
	AppState             json.RawMessage
}
type RecordInput struct {
	Mutation
	ItemID     *string
	Kind, Text string
	Refs       json.RawMessage
}
type EventInput struct {
	Mutation
	TargetBotID, Type string
	Payload           json.RawMessage
}
type AckEventInput struct{ TaskID, ID, OperationID, State string }
type InquiryInput struct {
	Mutation
	ItemID   *string
	Question string
}
type AnswerInput struct {
	Mutation
	Answer string
}

type RulesValidator func(oldRules, newRules json.RawMessage) (bool, error)
type Module struct {
	mu         sync.RWMutex
	validators map[string]RulesValidator
}

func New() *Module { return &Module{validators: make(map[string]RulesValidator)} }
