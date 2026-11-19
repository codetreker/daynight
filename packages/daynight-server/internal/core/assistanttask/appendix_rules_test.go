package assistanttask

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const outcomeID = "88888888-8888-4888-8888-888888888888"

func fullScope() *model.AssistantTaskAppendixScope {
	return &model.AssistantTaskAppendixScope{ProjectIDs: []string{targetID}, EventTypes: []string{"report", "escalation"}, ItemCategories: []string{"build failure"}}
}

func TestAppendixScopeAcceptsBoundedKnownSets(t *testing.T) {
	empty := model.AssistantTaskAppendixScope{ProjectIDs: []string{}, EventTypes: []string{}, ItemCategories: []string{}}
	for name, scope := range map[string]*model.AssistantTaskAppendixScope{"absent": nil, "empty": {}} {
		got, err := appendixScope(scope)
		if err != nil || !reflect.DeepEqual(got, empty) {
			t.Fatalf("%s scope: %#v %v", name, got, err)
		}
	}
	got, err := appendixScope(fullScope())
	if err != nil || !reflect.DeepEqual(got, *fullScope()) {
		t.Fatalf("full scope: %#v %v", got, err)
	}
	limit := make([]string, MaxAppendixScopeEntries)
	for i := range limit {
		limit[i] = strings.Repeat("c", i+1)
	}
	limit[0] = strings.Repeat("x", MaxAppendixCategoryBytes)
	limit[1] = " build "
	got, err = appendixScope(&model.AssistantTaskAppendixScope{ItemCategories: limit})
	if err != nil || !reflect.DeepEqual(got.ItemCategories, limit) {
		t.Fatalf("boundary or padded categories not kept verbatim: %#v %v", got.ItemCategories, err)
	}
}

func TestAppendixScopeRefusesInvalidSets(t *testing.T) {
	many := make([]string, MaxAppendixScopeEntries+1)
	for i := range many {
		many[i] = strings.Repeat("c", i+1)
	}
	cases := map[string]model.AssistantTaskAppendixScope{
		"noncanonical-project": {ProjectIDs: []string{strings.ReplaceAll(targetID, "-", "")}},
		"zero-project":         {ProjectIDs: []string{"00000000-0000-0000-0000-000000000000"}},
		"duplicate-project":    {ProjectIDs: []string{targetID, targetID}},
		"unknown-event":        {EventTypes: []string{"retro"}},
		"blank-category":       {ItemCategories: []string{" "}},
		"long-category":        {ItemCategories: []string{strings.Repeat("x", MaxAppendixCategoryBytes+1)}},
		"nul-category":         {ItemCategories: []string{"a\x00b"}},
		"duplicate-category":   {ItemCategories: []string{"build", "build"}},
		"too-many":             {ItemCategories: many},
	}
	for name, scope := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := appendixScope(&scope)
			requireCode(t, err, "invalid_input")
		})
	}
}

func TestAppendixAddStoresDeclaredScopeInFingerprint(t *testing.T) {
	for _, declared := range []bool{false, true} {
		task := baseTask()
		d := baseDAO(t, task)
		d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
			return model.AssistantTaskAppendix{}, model.ErrNotFound
		}
		input := AppendixInput{Mutation: mutation(), Text: "Restart the runner", SourceRecords: []string{}}
		request := []any{entryID, taskID, ptr(botID), input.Text, []string{}}
		want, _ := appendixScope(nil)
		if declared {
			input.Scope = fullScope()
			want = *fullScope()
			request = append(request, want)
		}
		hash := savedFingerprint(t, request)
		d.insertAppendix = func(_ context.Context, appendix model.AssistantTaskAppendix) (bool, error) {
			if !reflect.DeepEqual(appendix.Scope, want) || appendix.RequestFingerprint != hash || appendix.SuccessCount != 0 || appendix.FailureCount != 0 || appendix.LastValidatedAt != nil {
				t.Fatalf("wrong scoped appendix: %#v", appendix)
			}
			return true, nil
		}
		expectSystemEffects(t, d, "note", "appendix_added", botID)
		expectTaskWrite(t, d, task, true)
		if _, err := New().AddAppendix(context.Background(), d, botActor(), input); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAppendixInvalidScopeIsRefusedBeforeStorage(t *testing.T) {
	scope := &model.AssistantTaskAppendixScope{EventTypes: []string{"unknown"}}
	// The empty stub fails on any storage call, proving refusal precedes reads.
	_, err := New().AddAppendix(context.Background(), &daoStub{}, botActor(), AppendixInput{Mutation: mutation(), Text: "Text", Scope: scope})
	requireCode(t, err, "invalid_input")
	_, err = New().UpdateAppendix(context.Background(), &daoStub{}, userActor(), AppendixInput{Mutation: mutation(), State: "edited", Text: "Text", Scope: scope})
	requireCode(t, err, "invalid_input")
	_, err = New().UpdateAppendix(context.Background(), &daoStub{}, userActor(), AppendixInput{Mutation: mutation(), State: "deleted", Scope: fullScope()})
	requireCode(t, err, "invalid_input")
}

func TestAppendixUserEditReplacesScopeOnlyWhenDeclared(t *testing.T) {
	for _, declared := range []bool{false, true} {
		task := baseTask()
		d := baseDAO(t, task)
		old := model.AssistantTaskAppendix{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, Version: 3, Text: "Old", State: "active", SourceRecords: []string{}, Scope: *fullScope(), SuccessCount: 2, LastValidatedAt: ptr(epoch)}
		d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) { return old, nil }
		input := AppendixInput{Mutation: mutation(), State: "edited", Text: "New"}
		want := *fullScope()
		if declared {
			input.Scope = &model.AssistantTaskAppendixScope{ItemCategories: []string{"deploy"}}
			want = model.AssistantTaskAppendixScope{ProjectIDs: []string{}, EventTypes: []string{}, ItemCategories: []string{"deploy"}}
		}
		d.saveAppendix = func(_ context.Context, value model.AssistantTaskAppendix, version int64) (bool, error) {
			if version != 3 || value.Version != 4 || !reflect.DeepEqual(value.Scope, want) || value.SuccessCount != 2 || value.LastValidatedAt == nil {
				t.Fatalf("wrong scope edit: %#v", value)
			}
			return true, nil
		}
		expectTaskWrite(t, d, task, false)
		if _, err := New().UpdateAppendix(context.Background(), d, userActor(), input); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAppendixDeletionStopsOnValidationRemovalFailure(t *testing.T) {
	d := baseDAO(t, baseTask())
	d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
		return model.AssistantTaskAppendix{ID: entryID, State: "active", Version: 1}, nil
	}
	d.deleteValidations = func(context.Context, string, string, string) error { return sentinel }
	_, err := New().UpdateAppendix(context.Background(), d, userActor(), AppendixInput{Mutation: mutation(), State: "deleted"})
	if !errors.Is(err, sentinel) {
		t.Fatalf("want storage failure, got %v", err)
	}
}

func validationInput() AppendixValidationInput {
	return AppendixValidationInput{Mutation: mutation(), OutcomeRecordID: outcomeID}
}

// validationDAO serves one appendix and one record of the task; other IDs are
// absent, as for resources of another task.
func validationDAO(t *testing.T, appendix model.AssistantTaskAppendix, record *model.AssistantTaskRecord) *daoStub {
	t.Helper()
	d := baseDAO(t, baseTask())
	d.appendix = func(_ context.Context, owner, task, id string) (model.AssistantTaskAppendix, error) {
		if owner != ownerID || task != taskID || id != entryID {
			t.Fatalf("appendix lookup left task scope: %s %s %s", owner, task, id)
		}
		return appendix, nil
	}
	d.record = func(_ context.Context, owner, task, id string) (model.AssistantTaskRecord, error) {
		if owner != ownerID || task != taskID {
			t.Fatalf("record lookup left task scope: %s %s", owner, task)
		}
		if record != nil && id == record.ID {
			return *record, nil
		}
		return model.AssistantTaskRecord{}, model.ErrNotFound
	}
	return d
}

func activeAppendix() model.AssistantTaskAppendix {
	return model.AssistantTaskAppendix{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, Text: "Restart", State: "active", Version: 5, SuccessCount: 3, FailureCount: 1, Scope: *fullScope()}
}

func TestAppendixValidationCountsEffectiveAndIneffectiveOutcomes(t *testing.T) {
	for _, value := range []string{"effective", "ineffective"} {
		t.Run(value, func(t *testing.T) {
			d := validationDAO(t, activeAppendix(), &model.AssistantTaskRecord{ID: outcomeID, TaskID: taskID, Kind: "outcome", Outcome: ptr(value)})
			order := []string{}
			d.insertValidation = func(_ context.Context, v model.AssistantTaskAppendixValidation) (bool, error) {
				order = append(order, "validation")
				want := model.AssistantTaskAppendixValidation{OwnerUserID: ownerID, TaskID: taskID, AppendixID: entryID, OutcomeRecordID: outcomeID, Outcome: value, ValidatorBotID: botID, CreatedAt: epoch}
				if v != want {
					t.Fatalf("wrong validation: %#v", v)
				}
				return true, nil
			}
			success, failure := int64(3), int64(1)
			if value == "effective" {
				success++
			} else {
				failure++
			}
			d.saveAppendix = func(_ context.Context, v model.AssistantTaskAppendix, version int64) (bool, error) {
				order = append(order, "appendix")
				if version != 5 || v.Version != 5 || v.SuccessCount != success || v.FailureCount != failure || v.LastValidatedAt == nil || !v.LastValidatedAt.Equal(epoch) || v.Text != "Restart" || !reflect.DeepEqual(v.Scope, *fullScope()) {
					t.Fatalf("wrong counted appendix: %#v %d", v, version)
				}
				return true, nil
			}
			expectTaskWrite(t, d, baseTask(), true)
			result, err := New().ValidateAppendix(context.Background(), d, botActor(), validationInput())
			if err != nil || result.SuccessCount != success || result.FailureCount != failure || !reflect.DeepEqual(order, []string{"validation", "appendix"}) {
				t.Fatalf("validation result: %#v %v %v", result, order, err)
			}
		})
	}
}

func TestAppendixValidationRefusalsDoNotCount(t *testing.T) {
	note := &model.AssistantTaskRecord{ID: outcomeID, Kind: "note"}
	inconclusive := &model.AssistantTaskRecord{ID: outcomeID, Kind: "outcome", Outcome: ptr("inconclusive")}
	effective := &model.AssistantTaskRecord{ID: outcomeID, Kind: "outcome", Outcome: ptr("effective")}
	deleted := activeAppendix()
	deleted.State = "deleted"
	exhausted := activeAppendix()
	exhausted.SuccessCount = 1<<63 - 1
	cases := []struct {
		name     string
		appendix model.AssistantTaskAppendix
		record   *model.AssistantTaskRecord
		code     string
		notFound bool
	}{
		{name: "inconclusive", appendix: activeAppendix(), record: inconclusive, code: "invalid_input"},
		{name: "not-outcome", appendix: activeAppendix(), record: note, code: "invalid_input"},
		{name: "other-task", appendix: activeAppendix(), record: nil, code: "invalid_input"},
		{name: "deleted-appendix", appendix: deleted, record: effective, notFound: true},
		{name: "count-exhausted", appendix: exhausted, record: effective, code: "invalid_input"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := validationDAO(t, c.appendix, c.record)
			_, err := New().ValidateAppendix(context.Background(), d, botActor(), validationInput())
			if c.notFound {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("want not found, got %v", err)
				}
				return
			}
			requireCode(t, err, c.code)
		})
	}
}

func TestAppendixValidationRequiresIdentityAndLiveClaim(t *testing.T) {
	for _, input := range []AppendixValidationInput{
		{Mutation: Mutation{TaskID: taskID, ID: "bad"}, OutcomeRecordID: outcomeID},
		{Mutation: mutation(), OutcomeRecordID: strings.ReplaceAll(outcomeID, "-", "")},
	} {
		_, err := New().ValidateAppendix(context.Background(), &daoStub{}, botActor(), input)
		requireCode(t, err, "invalid_input")
	}
	d := baseDAO(t, baseTask())
	input := validationInput()
	input.ClaimGeneration = 9
	_, err := New().ValidateAppendix(context.Background(), d, botActor(), input)
	requireCode(t, err, "claim_lost")
	_, err = New().ValidateAppendix(context.Background(), baseDAO(t, baseTask()), userActor(), validationInput())
	requireCode(t, err, "claim_lost")
	paused := baseTask()
	paused.State = "paused"
	_, err = New().ValidateAppendix(context.Background(), baseDAO(t, paused), botActor(), validationInput())
	requireCode(t, err, "task_paused")
}

func TestAppendixValidationDuplicatesAndConflictsAreRefused(t *testing.T) {
	effective := &model.AssistantTaskRecord{ID: outcomeID, Kind: "outcome", Outcome: ptr("effective")}
	d := validationDAO(t, activeAppendix(), effective)
	d.insertValidation = func(context.Context, model.AssistantTaskAppendixValidation) (bool, error) { return false, nil }
	_, err := New().ValidateAppendix(context.Background(), d, botActor(), validationInput())
	requireCode(t, err, "operation_conflict")

	d = validationDAO(t, activeAppendix(), effective)
	d.insertValidation = func(context.Context, model.AssistantTaskAppendixValidation) (bool, error) { return true, nil }
	d.saveAppendix = func(context.Context, model.AssistantTaskAppendix, int64) (bool, error) { return false, nil }
	_, err = New().ValidateAppendix(context.Background(), d, botActor(), validationInput())
	requireCode(t, err, "version_conflict")
}

func TestAppendixValidationPropagatesStorageFailures(t *testing.T) {
	effective := &model.AssistantTaskRecord{ID: outcomeID, Kind: "outcome", Outcome: ptr("effective")}
	for _, step := range []string{"appendix", "record", "now", "validation", "save", "task"} {
		t.Run(step, func(t *testing.T) {
			d := validationDAO(t, activeAppendix(), effective)
			d.insertValidation = func(context.Context, model.AssistantTaskAppendixValidation) (bool, error) { return true, nil }
			d.saveAppendix = func(context.Context, model.AssistantTaskAppendix, int64) (bool, error) { return true, nil }
			nows := 0
			switch step {
			case "appendix":
				d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
					return model.AssistantTaskAppendix{}, sentinel
				}
			case "record":
				d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
					return model.AssistantTaskRecord{}, sentinel
				}
			case "now":
				// The first clock read admits the claim; the second stamps the validation.
				d.now = func(context.Context) (time.Time, error) {
					nows++
					if nows == 2 {
						return time.Time{}, sentinel
					}
					return epoch, nil
				}
			case "validation":
				d.insertValidation = func(context.Context, model.AssistantTaskAppendixValidation) (bool, error) { return false, sentinel }
			case "save":
				d.saveAppendix = func(context.Context, model.AssistantTaskAppendix, int64) (bool, error) { return false, sentinel }
			case "task":
				d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
					return false, sentinel
				}
			}
			_, err := New().ValidateAppendix(context.Background(), d, botActor(), validationInput())
			if !errors.Is(err, sentinel) {
				t.Fatalf("want storage failure, got %v", err)
			}
		})
	}
}
