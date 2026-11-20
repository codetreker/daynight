package assistanttask

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type policyDAO struct {
	store.AssistantTaskDAO
	read func(context.Context, model.Principal) (model.CredentialAuthorization, error)
}

func (d policyDAO) CredentialAuthorization(ctx context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	return d.read(ctx, p)
}
func scopeActor(t *testing.T, scopes ...scopepolicy.ScopeID) Actor {
	t.Helper()
	actor := userActor()
	ids, err := scopepolicy.Normalize(scopepolicy.PAT, scopes)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	actor.Authorization = &model.CredentialAuthorization{Principal: actor.Principal, Profile: model.ScopedPATProfile, Policy: &policy}
	return actor
}
func withPolicy(dao store.AssistantTaskDAO, authorization *model.CredentialAuthorization) policyDAO {
	return policyDAO{AssistantTaskDAO: dao, read: func(_ context.Context, _ model.Principal) (model.CredentialAuthorization, error) {
		return *authorization, nil
	}}
}
func TestScopedTaskUpdateRequiresFieldPermissionsBeforeMutation(t *testing.T) {
	name, paused, deleted := "changed", "paused", "deleted"
	cases := []struct {
		name   string
		input  UpdateInput
		scopes []scopepolicy.ScopeID
		allow  bool
	}{
		{"title allowed", UpdateInput{TaskID: taskID, IfVersion: 7, Name: &name}, []scopepolicy.ScopeID{"assistant-task:read", "assistant-task:write"}, true},
		{"title needs write", UpdateInput{TaskID: taskID, IfVersion: 7, Name: &name}, []scopepolicy.ScopeID{"assistant-task:read", "assistant-task:operate"}, false},
		{"strict response needs read", UpdateInput{TaskID: taskID, IfVersion: 7, Name: &name}, []scopepolicy.ScopeID{"assistant-task:write"}, false},
		{"pause needs operate", UpdateInput{TaskID: taskID, IfVersion: 7, State: &paused}, []scopepolicy.ScopeID{"assistant-task:read", "assistant-task:write"}, false},
		{"delete needs delete", UpdateInput{TaskID: taskID, IfVersion: 7, State: &deleted}, []scopepolicy.ScopeID{"assistant-task:read", "assistant-task:write", "assistant-task:operate"}, false},
		{"mixed needs both", UpdateInput{TaskID: taskID, IfVersion: 7, State: &paused, Name: &name}, []scopepolicy.ScopeID{"assistant-task:read", "assistant-task:write"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			writes := 0
			d.saveTask = func(_ context.Context, _ model.AssistantTask, _ store.AssistantTaskCondition) (bool, error) {
				writes++
				return true, nil
			}
			d.deleteTaskContent = func(context.Context, string, string) error { writes++; return nil }
			actor := scopeActor(t, tc.scopes...)
			_, err := New().Update(context.Background(), withPolicy(d, actor.Authorization), actor, tc.input)
			if tc.allow {
				if err != nil || writes != 1 {
					t.Fatalf("allowed: writes=%d error=%v", writes, err)
				}
				return
			}
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || writes != 0 {
				t.Fatalf("refusal: writes=%d error=%v", writes, err)
			}
		})
	}
}
func TestScopedAdmissionUsesTransactionAuthorityAndVisibility(t *testing.T) {
	actor := scopeActor(t, "assistant-task:read")
	d := baseDAO(t, baseTask())
	calls := 0
	newer := scopeActor(t, "assistant-task:write")
	wrapped := policyDAO{AssistantTaskDAO: d, read: func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		calls++
		if p != actor.Principal {
			t.Fatal("wrong principal")
		}
		return *newer.Authorization, nil
	}}
	_, err := New().Get(context.Background(), wrapped, actor, taskID)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || calls != 1 {
		t.Fatalf("stale snapshot accepted: calls=%d err=%v", calls, err)
	}
	d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
		return model.AssistantTask{}, model.ErrNotFound
	}
	calls = 0
	_, err = New().Get(context.Background(), wrapped, actor, taskID)
	if !errors.Is(err, model.ErrNotFound) || calls != 0 {
		t.Fatalf("resource visibility: calls=%d err=%v", calls, err)
	}
	d = baseDAO(t, baseTask())
	if _, err = New().Get(context.Background(), d, actor, taskID); err == nil {
		t.Fatal("missing transaction policy reader accepted")
	}
	mismatch := *actor.Authorization
	mismatch.Principal.CredentialID = entryID
	actor.Authorization = &mismatch
	if _, err = New().Get(context.Background(), withPolicy(d, actor.Authorization), actor, taskID); err == nil {
		t.Fatal("different credential accepted")
	}
}
func TestScopedInboxRequiresIndependentCapabilityAndSuppressesSecretOnFailure(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scopes []scopepolicy.ScopeID
		want   bool
	}{
		{"read alone", []scopepolicy.ScopeID{"assistant-task:read"}, false},
		{"inbox alone", []scopepolicy.ScopeID{"assistant-task:inbox"}, false},
		{"both", []scopepolicy.ScopeID{"assistant-task:inbox", "assistant-task:read"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, c := inboxDAO(t, baseTask(), nil)
			actor := scopeActor(t, tc.scopes...)
			got, err := New().EnableInbox(context.Background(), withPolicy(d, actor.Authorization), actor, inboxInput(""))
			if tc.want {
				if err != nil || got.Token == "" || len(c.inserted) != 1 {
					t.Fatalf("enable token=%q writes=%d error=%v", got.Token, len(c.inserted), err)
				}
				return
			}
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || got.Token != "" || len(c.inserted) != 0 || len(c.receipts) != 0 {
				t.Fatalf("refusal result=%+v writes=%+v error=%v", got, c, err)
			}
		})
	}
	d, _ := inboxDAO(t, baseTask(), nil)
	actor := scopeActor(t, "assistant-task:inbox", "assistant-task:read")
	calls := 0
	after := scopeActor(t, "assistant-task:read")
	wrapped := policyDAO{AssistantTaskDAO: d, read: func(_ context.Context, _ model.Principal) (model.CredentialAuthorization, error) {
		calls++
		if calls == 1 {
			return *actor.Authorization, nil
		}
		return *after.Authorization, nil
	}}
	got, err := New().EnableInbox(context.Background(), wrapped, actor, inboxInput(""))
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || got.Token != "" || calls != 2 {
		t.Fatalf("final refusal leaked token: result=%+v calls=%d error=%v", got, calls, err)
	}
}
func TestScopedReadRefusalPrecedesMaintenance(t *testing.T) {
	actor := scopeActor(t, "assistant-task:write")
	d := baseDAO(t, baseTask())
	wrapped := withPolicy(d, actor.Authorization)
	if _, err := New().ListInquiries(context.Background(), wrapped, actor, taskID, PageInput{}); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("inquiries %v", err)
	}
	if _, err := New().ListEvents(context.Background(), wrapped, actor, taskID, PageInput{}); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("events %v", err)
	}
}

func TestScopedClaimStillRequiresOriginalBotClaim(t *testing.T) {
	actor := scopeActor(t, "assistant-task:operate", "assistant-task:read")
	actor.BotID = ptr(botID)
	d := baseDAO(t, baseTask())
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{}, model.ErrNotFound
	}
	writes := 0
	d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
		writes++
		return true, nil
	}
	badToken := "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
	_, err := New().Claim(context.Background(), withPolicy(d, actor.Authorization), actor, ClaimInput{TaskID: taskID, OperationID: entryID, Kind: "renew", ClaimToken: badToken, ExpectedGeneration: 2})
	requireCode(t, err, "claim_lost")
	if writes != 0 {
		t.Fatal("invalid claim wrote state")
	}
}

func TestScopedAppendixDeleteAndEditUseDistinctCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name, state string
		scopes      []scopepolicy.ScopeID
		allow       bool
	}{
		{"delete cannot use write", "deleted", []scopepolicy.ScopeID{"assistant-task:read", "assistant-task:write"}, false},
		{"delete uses delete", "deleted", []scopepolicy.ScopeID{"assistant-task:delete", "assistant-task:read"}, true},
		{"edit cannot use delete", "edited", []scopepolicy.ScopeID{"assistant-task:delete", "assistant-task:read"}, false},
		{"edit uses write", "edited", []scopepolicy.ScopeID{"assistant-task:read", "assistant-task:write"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			writes := 0
			d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
				return model.AssistantTaskAppendix{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, State: "active", Version: 1}, nil
			}
			d.deleteValidations = func(context.Context, string, string, string) error { writes++; return nil }
			d.saveAppendix = func(context.Context, model.AssistantTaskAppendix, int64) (bool, error) { writes++; return true, nil }
			d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
				writes++
				return true, nil
			}
			actor := scopeActor(t, tc.scopes...)
			_, err := New().UpdateAppendix(context.Background(), withPolicy(d, actor.Authorization), actor, AppendixInput{Mutation: Mutation{TaskID: taskID, ID: entryID, IfVersion: 7}, State: tc.state, Text: "revised"})
			if !tc.allow {
				if !errors.Is(err, scopepolicy.ErrInsufficientScope) || writes != 0 {
					t.Fatalf("refusal writes=%d error=%v", writes, err)
				}
				return
			}
			if err != nil || writes == 0 {
				t.Fatalf("allowed writes=%d error=%v", writes, err)
			}
		})
	}
}

func TestScopeContractsShareBusinessClassification(t *testing.T) {
	contract, ok := ScopeContractFor("core.Module.Update")
	if !ok || len(contract.Branches) != 4 || contract.Combination == "" {
		t.Fatalf("update contract: %+v %v", contract, ok)
	}
	actor := scopeActor(t, "assistant-task:read", "assistant-task:write")
	selected := actor.requiringBranches("Update", "response", "ordinary")
	if err := scopeAdmission(context.Background(), withPolicy(baseDAO(t, baseTask()), actor.Authorization), selected); err != nil {
		t.Fatalf("selected branches: %v", err)
	}
	selected = actor.requiringBranches("Update", "response", "ordinary", "delete")
	if err := scopeAdmission(context.Background(), withPolicy(baseDAO(t, baseTask()), actor.Authorization), selected); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("missing delete: %v", err)
	}
	contract.Branches[0].Operations[0] = "invalid"
	reread, _ := ScopeContractFor("core.Module.Update")
	if reread.Branches[0].Operations[0] != scopepolicy.AssistantTaskRead {
		t.Fatal("caller changed shared contract")
	}
	if _, ok = ScopeContractFor("core.Module.Unknown"); ok {
		t.Fatal("unknown method classified")
	}
	if err := scopeAdmission(context.Background(), withPolicy(baseDAO(t, baseTask()), actor.Authorization), actor.requiringBranches("Update", "unknown")); err == nil {
		t.Fatal("unknown branch admitted")
	}
}

func TestScopedTargetBotVisibilityPrecedesScopeRefusal(t *testing.T) {
	for _, name := range []string{"attention", "preset", "transfer"} {
		t.Run(name, func(t *testing.T) {
			actor := scopeActor(t, "assistant-task:read")
			d := baseDAO(t, baseTask())
			d.bot = func(context.Context, string) (model.Bot, error) { return model.Bot{}, model.ErrNotFound }
			d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
				return model.AssistantTaskClaimOperation{}, model.ErrNotFound
			}
			calls := 0
			wrapped := policyDAO{AssistantTaskDAO: d, read: func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
				calls++
				return *actor.Authorization, nil
			}}
			var err error
			switch name {
			case "attention":
				err = New().ClearAttention(context.Background(), wrapped, actor, targetID)
			case "preset":
				input := createInput()
				input.Application = "watchdog"
				_, err = New().EnablePreset(context.Background(), wrapped, actor, input, targetID)
			case "transfer":
				version := int64(7)
				_, err = New().Claim(context.Background(), wrapped, actor, ClaimInput{TaskID: taskID, OperationID: entryID, Kind: "transfer", IfVersion: &version, ExpectedGeneration: 2, TargetBotID: ptr(targetID)})
			}
			requireCode(t, err, "forbidden")
			if calls != 0 {
				t.Fatalf("revealed scope before Bot visibility: %d", calls)
			}
		})
	}
}

func TestScopedTransferReplayDoesNotRequireTargetBot(t *testing.T) {
	actor := scopeActor(t, "assistant-task:operate", "assistant-task:read")
	version := int64(7)
	input := ClaimInput{TaskID: taskID, OperationID: entryID, Kind: "transfer", IfVersion: &version, ExpectedGeneration: 2, TargetBotID: ptr(targetID)}
	fingerprint, _, err := ClaimFingerprint(actor, input)
	if err != nil {
		t.Fatal(err)
	}
	d := baseDAO(t, baseTask())
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{RequestFingerprint: fingerprint}, nil
	}
	d.bot = func(context.Context, string) (model.Bot, error) {
		t.Fatal("replay checked target Bot")
		return model.Bot{}, nil
	}
	if _, err = New().Claim(context.Background(), withPolicy(d, actor.Authorization), actor, input); err != nil {
		t.Fatalf("replay: %v", err)
	}
}
