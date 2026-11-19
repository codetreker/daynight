package model

import (
	"encoding/json"
	"time"
)

// AssistantTask is an account-owned collaboration resource, independent of Task.
type AssistantTask struct {
	ID, OwnerUserID, Application, Name, Purpose, Scope string
	Kind, State, Takeover, RequestFingerprint          string
	Trigger                                            json.RawMessage
	Version, ManualVersion, ClaimGeneration            int64
	HolderBotID, ClaimTokenHash, CredentialOperationID *string
	ClaimedAt, RenewedAt, LeaseUntil                   *time.Time
	HolderDeleted                                      bool
	CreatedAt, UpdatedAt, ObservedAt                   time.Time
}

type AssistantTaskClaim struct {
	HolderBotID, CredentialOperationID *string
	Generation                         int64
	State                              string
	ClaimedAt, RenewedAt, LeaseUntil   *time.Time
	ObservedAt                         time.Time
}

type AssistantTaskClaimOperation struct {
	OwnerUserID, OperationID, Kind, TaskID, RequestFingerprint string
	ActorBotID, HolderBotID, CredentialOperationID             *string
	AdmittedAt                                                 time.Time
	ResultingVersion, ResultingGeneration                      int64
	LeaseUntil                                                 *time.Time
}

type AssistantTaskClaimResult struct {
	Operation    AssistantTaskClaimOperation
	CurrentClaim AssistantTaskClaim
}

type AssistantTaskClaimError struct {
	Fault *Fault
	Claim AssistantTaskClaim
}

func (e *AssistantTaskClaimError) Error() string { return e.Fault.Error() }
func (e *AssistantTaskClaimError) Unwrap() error { return e.Fault }

type AssistantTaskManual struct {
	OwnerUserID, TaskID, Body, Source string
	Version                           int64
	Rules                             json.RawMessage
	ProposalID                        *string
	CreatedAt                         time.Time
}

type AssistantTaskAppendix struct {
	ID, OwnerUserID, TaskID, Text, State, RequestFingerprint string
	SourceRecords                                            []string
	AuthorBotID                                              *string
	Version                                                  int64
	CreatedAt, UpdatedAt                                     time.Time
	// Scope narrows where the experience applies; an empty set leaves that
	// dimension unrestricted.
	Scope AssistantTaskAppendixScope
	// SuccessCount, FailureCount and LastValidatedAt summarize the registered
	// validations and change only with them, never with the appendix Version.
	SuccessCount, FailureCount int64
	LastValidatedAt            *time.Time
}

type AssistantTaskAppendixScope struct {
	ProjectIDs, EventTypes, ItemCategories []string
}

// AssistantTaskAppendixValidation registers one outcome record as evidence for
// one appendix; the pair is unique.
type AssistantTaskAppendixValidation struct {
	OwnerUserID, TaskID, AppendixID, OutcomeRecordID, Outcome, ValidatorBotID string
	CreatedAt                                                                 time.Time
}

type AssistantTaskProposal struct {
	ID, OwnerUserID, TaskID, Body, Reason, Status, DecisionNote, RequestFingerprint string
	BaseVersion                                                                     int64
	Rules                                                                           json.RawMessage
	EvidenceRecords                                                                 []string
	AuthorBotID                                                                     *string
	Widens                                                                          bool
	CreatedAt                                                                       time.Time
	DecidedAt                                                                       *time.Time
}

type AssistantTaskItem struct {
	ID, OwnerUserID, TaskID, Key, State, Category, RequestFingerprint string
	Episode, Version                                                  int64
	FollowerBotID                                                     *string
	AppState                                                          json.RawMessage
	CreatedAt, UpdatedAt                                              time.Time
}

type AssistantTaskRecord struct {
	ID, OwnerUserID, TaskID, Author, Kind, Text, RequestFingerprint string
	ItemID, AuthorBotID                                             *string
	// Outcome and ActionRecordID are set only on outcome records, which
	// evaluate one action record of the same task.
	Outcome, ActionRecordID *string
	Refs                    json.RawMessage
	CreatedAt               time.Time
}

type AssistantTaskEvent struct {
	ID, OwnerUserID, TaskID, TargetBotID, Type, State, RequestFingerprint string
	Payload                                                               json.RawMessage
	Attention                                                             bool
	CreatedAt                                                             time.Time
	DeliveredAt, SeenAt                                                   *time.Time
	AckOperationID, AckFingerprint                                        *string
}

type AssistantTaskInquiry struct {
	ID, OwnerUserID, TaskID, FromBotID, ToBotID, Question, Answer, State, RequestFingerprint string
	ItemID, AnswerBotID                                                                      *string
	CreatedAt, Deadline                                                                      time.Time
	AnsweredAt                                                                               *time.Time
}

type AssistantTaskPage[T any] struct {
	Items      []T
	NextCursor *string
	ObservedAt time.Time
}
