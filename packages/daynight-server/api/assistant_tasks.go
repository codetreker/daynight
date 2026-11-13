package api

import (
	"encoding/json"
	"time"
)

type AssistantTaskClaim struct {
	HolderBotID           *string    `json:"holderBotId"`
	CredentialOperationID *string    `json:"credentialOperationId"`
	Generation            int64      `json:"claimGeneration,string"`
	State                 string     `json:"claimState"`
	ClaimedAt             *time.Time `json:"claimedAt"`
	RenewedAt             *time.Time `json:"renewedAt"`
	LeaseUntil            *time.Time `json:"leaseUntil"`
	ObservedAt            time.Time  `json:"observedAt"`
}

type AssistantTask struct {
	ID            string          `json:"id"`
	OwnerUserID   string          `json:"ownerUserId"`
	Application   string          `json:"application"`
	Name          string          `json:"name"`
	Purpose       string          `json:"purpose"`
	Scope         string          `json:"scope"`
	Kind          string          `json:"kind"`
	State         string          `json:"state"`
	Takeover      string          `json:"takeover"`
	Trigger       json.RawMessage `json:"trigger"`
	Version       int64           `json:"version,string"`
	ManualVersion int64           `json:"manualVersion,string"`
	AssistantTaskClaim
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type AssistantTaskClaimOperation struct {
	OperationID           string     `json:"operationId"`
	Kind                  string     `json:"kind"`
	TaskID                string     `json:"taskId"`
	ActorBotID            *string    `json:"actorBotId"`
	RequestFingerprint    string     `json:"requestFingerprint"`
	AdmittedAt            time.Time  `json:"admittedAt"`
	ResultingVersion      int64      `json:"resultingVersion,string"`
	ResultingGeneration   int64      `json:"resultingGeneration,string"`
	HolderBotID           *string    `json:"holderBotId"`
	CredentialOperationID *string    `json:"credentialOperationId"`
	LeaseUntil            *time.Time `json:"leaseUntil"`
}

type AssistantTaskClaimResult struct {
	Operation    AssistantTaskClaimOperation `json:"operation"`
	CurrentClaim AssistantTaskClaim          `json:"currentClaim"`
}

type AssistantTaskManual struct {
	TaskID     string          `json:"taskId"`
	Version    int64           `json:"version,string"`
	Body       string          `json:"body"`
	Rules      json.RawMessage `json:"rules"`
	Source     string          `json:"source"`
	ProposalID *string         `json:"proposalId"`
	CreatedAt  time.Time       `json:"createdAt"`
}

type AssistantTaskAppendix struct {
	ID            string    `json:"id"`
	TaskID        string    `json:"taskId"`
	Text          string    `json:"text"`
	SourceRecords []string  `json:"sourceRecords"`
	AuthorBotID   *string   `json:"authorBotId"`
	State         string    `json:"state"`
	Version       int64     `json:"version,string"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type AssistantTaskProposal struct {
	ID              string          `json:"id"`
	TaskID          string          `json:"taskId"`
	BaseVersion     int64           `json:"baseVersion,string"`
	Body            string          `json:"body"`
	Rules           json.RawMessage `json:"rules"`
	Reason          string          `json:"reason"`
	EvidenceRecords []string        `json:"evidenceRecords"`
	AuthorBotID     *string         `json:"authorBotId"`
	Widens          bool            `json:"widens"`
	Status          string          `json:"status"`
	DecisionNote    string          `json:"decisionNote"`
	CreatedAt       time.Time       `json:"createdAt"`
	DecidedAt       *time.Time      `json:"decidedAt"`
}

type AssistantTaskItem struct {
	ID            string          `json:"id"`
	TaskID        string          `json:"taskId"`
	Key           string          `json:"key"`
	Episode       int64           `json:"episode,string"`
	State         string          `json:"state"`
	Category      string          `json:"category"`
	FollowerBotID *string         `json:"followerBotId"`
	AppState      json.RawMessage `json:"appState"`
	Version       int64           `json:"version,string"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

type AssistantTaskRecord struct {
	ID          string          `json:"id"`
	TaskID      string          `json:"taskId"`
	ItemID      *string         `json:"itemId"`
	Author      string          `json:"author"`
	AuthorBotID *string         `json:"authorBotId"`
	Kind        string          `json:"kind"`
	Text        string          `json:"text"`
	Refs        json.RawMessage `json:"refs"`
	CreatedAt   time.Time       `json:"createdAt"`
}

type AssistantTaskEvent struct {
	ID             string          `json:"id"`
	TaskID         string          `json:"taskId"`
	TargetBotID    string          `json:"targetBotId"`
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	State          string          `json:"state"`
	Attention      bool            `json:"attention"`
	CreatedAt      time.Time       `json:"createdAt"`
	DeliveredAt    *time.Time      `json:"deliveredAt"`
	SeenAt         *time.Time      `json:"seenAt"`
	AckOperationID *string         `json:"ackOperationId"`
}

type AssistantTaskInquiry struct {
	AnswerBotID *string    `json:"answerBotId"`
	ID          string     `json:"id"`
	TaskID      string     `json:"taskId"`
	ItemID      *string    `json:"itemId"`
	FromBotID   string     `json:"fromBotId"`
	ToBotID     string     `json:"toBotId"`
	Question    string     `json:"question"`
	Answer      string     `json:"answer"`
	State       string     `json:"state"`
	CreatedAt   time.Time  `json:"createdAt"`
	Deadline    time.Time  `json:"deadline"`
	AnsweredAt  *time.Time `json:"answeredAt"`
}

type AssistantTaskPage[T any] struct {
	Items      []T       `json:"items"`
	NextCursor *string   `json:"nextCursor"`
	ObservedAt time.Time `json:"observedAt"`
}
