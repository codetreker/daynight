package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestInquiryRoutesOpenItemsToFollowerAndClosedItemsToCurrentHolder(t *testing.T) {
	for _, state := range []string{"open", "closed", "no-item"} {
		t.Run(state, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			actor := botActor()
			actor.BotID = ptr(targetID)
			input := InquiryInput{Mutation: Mutation{TaskID: taskID, ID: entryID}, ItemID: ptr(operationID), Question: "What happened?"}
			wantTarget := botID
			if state == "no-item" {
				input.ItemID = nil
			} else {
				d.item = func(_ context.Context, owner, id, item string) (model.AssistantTaskItem, error) {
					if owner != ownerID || id != taskID || item != operationID {
						t.Fatal("wrong inquiry item")
					}
					return model.AssistantTaskItem{State: state, FollowerBotID: ptr(targetID)}, nil
				}
				if state == "open" {
					wantTarget = targetID
				}
			}
			d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
				return model.AssistantTaskInquiry{}, model.ErrNotFound
			}
			d.insertInquiry = func(_ context.Context, inquiry model.AssistantTaskInquiry) (bool, error) {
				if inquiry.ID != entryID || inquiry.FromBotID != targetID || inquiry.ToBotID != wantTarget || inquiry.State != "open" || inquiry.Deadline != epoch.Add(5*time.Minute) || inquiry.Question != input.Question {
					t.Fatalf("wrong question: %#v", inquiry)
				}
				return true, nil
			}
			effects := expectSystemEffects(t, d, "question", "inquiry", wantTarget)
			expectTaskWrite(t, d, task, false)
			result, err := New().Ask(context.Background(), d, actor, input)
			if err != nil || result.ToBotID != wantTarget || !reflect.DeepEqual(effects.record.ItemID, input.ItemID) || effects.event.Attention {
				t.Fatalf("inquiry: %#v %v", result, err)
			}
		})
	}
}

func TestInquiryProtectsClaimHolderWhenRoutingToAnotherFollower(t *testing.T) {
	for _, phase := range []string{"admission", "final"} {
		t.Run(phase, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			actor := botActor()
			actor.BotID = ptr(targetID)
			holderChecks := 0
			d.bot = func(_ context.Context, id string) (model.Bot, error) {
				bot := model.Bot{ID: id, OwnerUserID: ownerID}
				if id == botID {
					holderChecks++
					if phase == "admission" || holderChecks == 2 {
						bot.Deletion = &model.BotDeletion{}
					}
				} else if id != targetID {
					t.Fatal("wrong Bot scope")
				}
				return bot, nil
			}
			d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
				return model.AssistantTaskItem{State: "open", FollowerBotID: ptr(targetID)}, nil
			}
			d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
				if phase == "admission" {
					t.Fatal("question processing started without holder deletion barrier")
				}
				return model.AssistantTaskInquiry{}, model.ErrNotFound
			}
			if phase == "final" {
				d.insertInquiry = func(context.Context, model.AssistantTaskInquiry) (bool, error) { return true, nil }
				expectSystemEffects(t, d, "question", "inquiry", targetID)
				expectTaskWrite(t, d, task, false)
			}
			_, err := New().Ask(context.Background(), d, actor, InquiryInput{Mutation: mutation(), ItemID: ptr(operationID), Question: "Current status?"})
			requireCode(t, err, "claim_lost")
		})
	}
}

func TestInquiryRetainsTargetAndHolderStorageErrors(t *testing.T) {
	for _, failingBot := range []string{targetID, botID} {
		t.Run(failingBot, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			actor := botActor()
			if failingBot == botID {
				actor.BotID = ptr(targetID)
			}
			d.bot = func(_ context.Context, id string) (model.Bot, error) {
				if id == failingBot {
					return model.Bot{}, sentinel
				}
				return model.Bot{ID: id, OwnerUserID: ownerID}, nil
			}
			d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
				return model.AssistantTaskItem{State: "open", FollowerBotID: ptr(targetID)}, nil
			}
			_, err := New().Ask(context.Background(), d, actor, InquiryInput{Mutation: mutation(), ItemID: ptr(operationID), Question: "Current status?"})
			if !errors.Is(err, sentinel) {
				t.Fatalf("lost Bot lookup cause: %v", err)
			}
		})
	}
}

func answerFixture(t *testing.T) (*daoStub, AnswerInput, *effects) {
	t.Helper()
	task := baseTask()
	d := baseDAO(t, task)
	d.inquiry = func(_ context.Context, owner, id, inquiry string) (model.AssistantTaskInquiry, error) {
		if owner != ownerID || id != taskID || inquiry != entryID {
			t.Fatal("wrong answer scope")
		}
		return model.AssistantTaskInquiry{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, FromBotID: targetID, ToBotID: targetID, State: "open", Deadline: epoch.Add(time.Minute)}, nil
	}
	d.saveInquiry = func(_ context.Context, value model.AssistantTaskInquiry, previous string) (bool, error) {
		if previous != "open" || value.State != "answered" || value.Answer != "Observed result" || value.ToBotID != targetID || value.AnswerBotID == nil || *value.AnswerBotID != botID || value.AnsweredAt == nil || *value.AnsweredAt != epoch {
			t.Fatalf("wrong answer attribution: %#v", value)
		}
		return true, nil
	}
	effects := expectSystemEffects(t, d, "answer", "answer", targetID)
	expectTaskWrite(t, d, task, true)
	return d, AnswerInput{Mutation: mutation(), Answer: "Observed result"}, effects
}

func TestNewResponsibleBotAnswersExistingInquiryWithoutRewritingOriginalTarget(t *testing.T) {
	d, input, effects := answerFixture(t)
	result, err := New().Answer(context.Background(), d, botActor(), input)
	var refs struct {
		InquiryID string `json:"inquiryId"`
		BotID     string `json:"botId"`
	}
	if decodeErr := json.Unmarshal(effects.record.Refs, &refs); decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if err != nil || result.State != "answered" || result.ToBotID != targetID || refs.BotID != botID || refs.InquiryID != entryID {
		t.Fatalf("answer: %#v %#v %v", result, refs, err)
	}
}

func TestAnswerRechecksInquiryDeadlineAfterStorageWait(t *testing.T) {
	d, input, _ := answerFixture(t)
	reads := 0
	d.now = func(context.Context) (time.Time, error) {
		reads++
		if reads >= 3 {
			return epoch.Add(time.Minute), nil
		}
		return epoch, nil
	}
	_, err := New().Answer(context.Background(), d, botActor(), input)
	requireCode(t, err, "invalid_transition")
}

func TestInquiryRejectsPausedUnownedAndLateAnswerWithoutWrites(t *testing.T) {
	for _, name := range []string{"user-question", "paused-question", "unowned-question", "expired-answer", "answered"} {
		t.Run(name, func(t *testing.T) {
			task, actor := baseTask(), botActor()
			code := "invalid_transition"
			if name == "user-question" {
				actor, code = userActor(), "forbidden"
			}
			if name == "paused-question" {
				task.State, code = "paused", "task_paused"
			}
			if name == "unowned-question" {
				task.HolderBotID, code = nil, "claim_lost"
			}
			d := baseDAO(t, task)
			var err error
			if name == "expired-answer" || name == "answered" {
				state := "open"
				if name == "answered" {
					state = "answered"
				}
				d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
					return model.AssistantTaskInquiry{State: state, Deadline: epoch}, nil
				}
				_, err = New().Answer(context.Background(), d, actor, AnswerInput{Mutation: mutation(), Answer: "Late"})
			} else {
				_, err = New().Ask(context.Background(), d, actor, InquiryInput{Mutation: mutation(), Question: "Question"})
			}
			requireCode(t, err, code)
		})
	}
}

func TestInquiryTimeoutPrefiltersDueQuestionsAndLocksTasksInOrder(t *testing.T) {
	d := baseDAO(t, baseTask())
	first, second := baseTask(), baseTask()
	second.ID = operationID
	due := []model.AssistantTaskInquiry{
		{ID: entryID, TaskID: operationID}, {ID: targetID, TaskID: taskID}, {ID: botID, TaskID: taskID},
	}
	d.inquiries = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
		if q.OwnerUserID != ownerID || q.TaskID != "" || q.State != "open" || q.InquiryBotID != botID || q.DeadlineBefore == nil || *q.DeadlineBefore != epoch || q.Limit != 200 {
			t.Fatalf("timeout must filter before pagination: %#v", q)
		}
		return due, nil
	}
	var locked []string
	d.task = func(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
		if owner != ownerID || !lock {
			t.Fatal("missing timeout task barrier")
		}
		locked = append(locked, id)
		if id == taskID {
			return first, nil
		}
		if id != operationID {
			t.Fatal("unexpected task")
		}
		return second, nil
	}
	d.inquiry = func(_ context.Context, owner, id, inquiry string) (model.AssistantTaskInquiry, error) {
		if !reflect.DeepEqual(locked, []string{taskID, operationID}) {
			t.Fatal("questions read before ordered task barriers")
		}
		value := model.AssistantTaskInquiry{ID: inquiry, OwnerUserID: owner, TaskID: id, FromBotID: botID, State: "open", Deadline: epoch}
		if inquiry == targetID {
			value.State = "answered"
		}
		if inquiry == botID {
			value.Deadline = epoch.Add(time.Minute)
		}
		return value, nil
	}
	writes, records, events, taskWrites := 0, 0, 0, 0
	d.saveInquiry = func(_ context.Context, value model.AssistantTaskInquiry, previous string) (bool, error) {
		writes++
		if value.ID != entryID || value.State != "timed_out" || previous != "open" || value.Answer != "" || value.AnsweredAt != nil {
			t.Fatalf("timeout fabricated answer: %#v", value)
		}
		return true, nil
	}
	d.insertRecord = func(_ context.Context, record model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
		records++
		if record.TaskID != operationID || record.Kind != "unknown" || record.Author != "system" {
			t.Fatal("wrong timeout record")
		}
		return record, nil
	}
	d.insertEvent = func(_ context.Context, event model.AssistantTaskEvent) (bool, error) {
		events++
		if event.TaskID != operationID || event.TargetBotID != botID || event.Type != "inquiry_timed_out" || !event.Attention {
			t.Fatal("wrong timeout notice")
		}
		return true, nil
	}
	d.saveTask = func(_ context.Context, value model.AssistantTask, condition store.AssistantTaskCondition) (bool, error) {
		taskWrites++
		if value.ID != operationID || value.Version != 8 || condition.Version != 7 || condition.CheckClaim {
			t.Fatal("wrong timeout task write")
		}
		return true, nil
	}
	if err := New().expireInquiries(context.Background(), d, userActor(), "", botID); err != nil {
		t.Fatal(err)
	}
	if writes != 1 || records != 1 || events != 1 || taskWrites != 1 {
		t.Fatalf("timeout repeated changed/not-yet-due inquiry: %d %d %d %d", writes, records, events, taskWrites)
	}
}
