package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMaterialReplayPreservesExistingOutcomeAndRejectsDifferentRequest(t *testing.T) {
	for _, resource := range []string{"appendix", "item", "record", "event", "inquiry"} {
		for _, conflict := range []bool{false, true} {
			t.Run(resource+map[bool]string{false: "/same", true: "/different"}[conflict], func(t *testing.T) {
				d, m := baseDAO(t, baseTask()), New()
				hash := func(value any) string {
					if conflict {
						return "different-request"
					}
					return savedFingerprint(t, value)
				}
				var err error
				switch resource {
				case "appendix":
					fingerprint := hash([]any{entryID, taskID, ptr(botID), "Original", []string(nil)})
					d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
						return model.AssistantTaskAppendix{ID: entryID, Text: "User edited later", State: "edited", Version: 4, RequestFingerprint: fingerprint}, nil
					}
					result, e := m.AddAppendix(context.Background(), d, botActor(), AppendixInput{Mutation: mutation(), Text: "Original"})
					err = e
					if !conflict && (result.Text != "User edited later" || result.Version != 4) {
						t.Fatal("replay restored old appendix")
					}
				case "item":
					input := itemInput()
					fingerprint := hash([]any{entryID, taskID, "build-1", int64(1), "open", "failure", json.RawMessage(`{"operationId":"original-operation"}`), ptr(botID)})
					d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
						return model.AssistantTaskItem{ID: entryID, State: "closed", Version: 4, RequestFingerprint: fingerprint}, nil
					}
					result, e := m.SaveItem(context.Background(), d, botActor(), input)
					err = e
					if !conflict && (result.State != "closed" || result.Version != 4) {
						t.Fatal("replay reopened item")
					}
				case "record":
					fingerprint := hash([]any{entryID, taskID, ptr(botID), (*string)(nil), "fact", "Original", json.RawMessage(`null`)})
					d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
						return model.AssistantTaskRecord{ID: entryID, CreatedAt: epoch.Add(-time.Minute), RequestFingerprint: fingerprint}, nil
					}
					result, e := m.AddRecord(context.Background(), d, botActor(), RecordInput{Mutation: mutation(), Kind: "fact", Text: "Original"})
					err = e
					if !conflict && result.CreatedAt != epoch.Add(-time.Minute) {
						t.Fatal("replay replaced record timestamp")
					}
				case "event":
					fingerprint := hash([]any{entryID, taskID, ptr(botID), botID, "report", json.RawMessage(`null`)})
					d.event = func(context.Context, string, string, string) (model.AssistantTaskEvent, error) {
						return model.AssistantTaskEvent{ID: entryID, State: "expired", RequestFingerprint: fingerprint}, nil
					}
					result, e := m.AddEvent(context.Background(), d, botActor(), EventInput{Mutation: mutation(), TargetBotID: botID, Type: "report"})
					err = e
					if !conflict && result.State != "expired" {
						t.Fatal("replay resurrected event")
					}
				case "inquiry":
					fingerprint := hash([]any{entryID, taskID, ptr(botID), (*string)(nil), "Question"})
					d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
						return model.AssistantTaskInquiry{ID: entryID, State: "answered", Answer: "Existing answer", RequestFingerprint: fingerprint}, nil
					}
					result, e := m.Ask(context.Background(), d, botActor(), InquiryInput{Mutation: mutation(), Question: "Question"})
					err = e
					if !conflict && (result.State != "answered" || result.Answer != "Existing answer") {
						t.Fatal("replay replaced original inquiry outcome")
					}
				}
				if conflict {
					requireCode(t, err, "operation_conflict")
				} else if err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestInvalidWorkInputsStopBeforeDAOAccess(t *testing.T) {
	d, m := &daoStub{}, New()
	for _, tc := range []struct {
		name   string
		invoke func() error
	}{
		{"appendix", func() error {
			_, e := m.AddAppendix(context.Background(), d, botActor(), AppendixInput{Mutation: mutation()})
			return e
		}},
		{"event-id", func() error { _, e := m.AddEvent(context.Background(), d, botActor(), EventInput{}); return e }},
		{"event-json", func() error {
			_, e := m.AddEvent(context.Background(), d, botActor(), EventInput{Mutation: mutation(), TargetBotID: botID, Type: "report", Payload: json.RawMessage(`invalid`)})
			return e
		}},
		{"record-kind", func() error {
			_, e := m.AddRecord(context.Background(), d, botActor(), RecordInput{Mutation: mutation(), Kind: "result", Text: "Text"})
			return e
		}},
		{"record-json", func() error {
			_, e := m.AddRecord(context.Background(), d, botActor(), RecordInput{Mutation: mutation(), Kind: "fact", Text: "Text", Refs: json.RawMessage(`invalid`)})
			return e
		}},
		{"question", func() error {
			_, e := m.Ask(context.Background(), d, botActor(), InquiryInput{Mutation: mutation()})
			return e
		}},
		{"answer", func() error {
			_, e := m.Answer(context.Background(), d, botActor(), AnswerInput{Mutation: mutation()})
			return e
		}},
		{"claim-operation", func() error { _, e := m.ClaimOperation(context.Background(), d, botActor(), taskID, "bad"); return e }},
		{"item-read", func() error { _, e := m.GetItem(context.Background(), d, botActor(), taskID, "bad"); return e }},
	} {
		t.Run(tc.name, func(t *testing.T) { requireCode(t, tc.invoke(), "invalid_input") })
	}
	_, err := m.AddRecord(context.Background(), d, userActor(), RecordInput{})
	requireCode(t, err, "forbidden")
}

func TestWorkingAdmissionStopsAfterTaskOrClockFailure(t *testing.T) {
	for _, stage := range []string{"task", "clock"} {
		t.Run(stage, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			if stage == "task" {
				d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
					return model.AssistantTask{}, sentinel
				}
			} else {
				d.now = func(context.Context) (time.Time, error) { return time.Time{}, sentinel }
			}
			_, err := New().SaveItem(context.Background(), d, botActor(), itemInput())
			if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
		})
	}
}

func TestAttentionAndEventReadsRetainPreconditionFailures(t *testing.T) {
	for _, stage := range []string{"auth", "target", "clock", "seen"} {
		t.Run("attention/"+stage, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			switch stage {
			case "auth":
				d.credential = func(context.Context, model.Principal) error { return sentinel }
			case "target":
				d.bot = func(context.Context, string) (model.Bot, error) { return model.Bot{}, sentinel }
			case "clock":
				d.now = func(context.Context) (time.Time, error) { return time.Time{}, sentinel }
			case "seen":
				d.seen = func(context.Context, string, string, time.Time, []string) error { return sentinel }
			}
			if err := New().ClearAttention(context.Background(), d, userActor(), botID); !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
		})
	}
	for _, stage := range []string{"invalid", "timeout-query", "events"} {
		t.Run("events/"+stage, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			input := PageInput{}
			if stage == "invalid" {
				input.State = "bad"
			} else {
				d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
					if stage == "timeout-query" {
						return nil, sentinel
					}
					return nil, nil
				}
				d.events = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) {
					return nil, sentinel
				}
			}
			_, err := New().ListEvents(context.Background(), d, userActor(), "", input)
			if stage == "invalid" {
				requireCode(t, err, "invalid_input")
			} else if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
		})
	}
}

func TestInquiryTimeoutStorageFailuresDoNotEmitLaterEffects(t *testing.T) {
	for _, stage := range []string{"query", "task", "inquiry", "save", "record", "event", "save-task"} {
		t.Run(stage, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			p := &failureProbe{t: t, at: stage, calls: map[string]bool{}}
			d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
				return []model.AssistantTaskInquiry{{ID: entryID, TaskID: taskID}}, p.call("query")
			}
			d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
				return baseTask(), p.call("task")
			}
			d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
				return model.AssistantTaskInquiry{ID: entryID, TaskID: taskID, OwnerUserID: ownerID, State: "open", Deadline: epoch, FromBotID: botID}, p.call("inquiry")
			}
			d.saveInquiry = func(context.Context, model.AssistantTaskInquiry, string) (bool, error) { return p.write("save") }
			d.insertRecord = func(_ context.Context, record model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
				return record, p.call("record")
			}
			d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) { return p.write("event") }
			d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
				return p.write("save-task")
			}
			if err := New().expireInquiries(context.Background(), d, userActor(), taskID, botID); !p.hit || !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
		})
	}
}
