package assistanttask

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Scope sets stay small enough to render in every appendix read and to match
// against a notification without a separate index.
const (
	MaxAppendixScopeEntries  = 20
	MaxAppendixCategoryBytes = 200
)

// appendixScope validates a declared scope and returns it with non-nil sets.
// A nil scope is the unrestricted scope. Item categories are compared verbatim
// with the free-text categories items store, so a scope category is only
// required to be nonblank and bounded; trimming or refusing surrounding
// whitespace would make such stored categories impossible to name.
func appendixScope(scope *model.AssistantTaskAppendixScope) (model.AssistantTaskAppendixScope, error) {
	result := model.AssistantTaskAppendixScope{ProjectIDs: []string{}, EventTypes: []string{}, ItemCategories: []string{}}
	if scope == nil {
		return result, nil
	}
	checks := []struct {
		values []string
		target *[]string
		valid  func(string) bool
	}{
		{scope.ProjectIDs, &result.ProjectIDs, strictID},
		{scope.EventTypes, &result.EventTypes, knownEventType},
		{scope.ItemCategories, &result.ItemCategories, func(value string) bool {
			return textValid(value, true) && len(value) <= MaxAppendixCategoryBytes
		}},
	}
	for _, check := range checks {
		if len(check.values) > MaxAppendixScopeEntries {
			return result, invalid("Appendix scope sets are limited to 20 entries.")
		}
		seen := make(map[string]bool, len(check.values))
		for _, value := range check.values {
			if !check.valid(value) || seen[value] {
				return result, invalid("Appendix scope requires canonical project IDs, known event types and distinct nonblank item categories.")
			}
			seen[value] = true
		}
		*check.target = append(*check.target, check.values...)
	}
	return result, nil
}

// ValidateAppendix registers one same-task outcome record as evidence for an
// appendix. Only the responsible Bot may validate; an effective outcome counts
// as a success, an ineffective one as a failure and an inconclusive one is
// refused. The registration is unique per outcome record and appendix, and the
// counts change in the same transaction as the registration.
func (m *Module) ValidateAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input AppendixValidationInput) (model.AssistantTaskAppendix, error) {
	var result model.AssistantTaskAppendix
	if !strictID(input.ID) || !strictID(input.OutcomeRecordID) {
		return result, invalid("Appendix ID and outcome record ID must be canonical UUIDs.")
	}
	task, err := m.workingTask(ctx, dao, actor, input.Mutation)
	if err != nil {
		return result, err
	}
	result, err = dao.Appendix(ctx, task.OwnerUserID, task.ID, input.ID)
	if err != nil {
		return result, err
	}
	if result.State == "deleted" {
		return result, model.ErrNotFound
	}
	record, err := dao.Record(ctx, task.OwnerUserID, task.ID, input.OutcomeRecordID)
	if errors.Is(err, model.ErrNotFound) || err == nil && (record.Kind != "outcome" || record.Outcome == nil) {
		return result, invalid("The outcome record ID must refer to an outcome record of this task.")
	}
	if err != nil {
		return result, err
	}
	switch *record.Outcome {
	case "effective":
		result.SuccessCount, err = advance(result.SuccessCount)
	case "ineffective":
		result.FailureCount, err = advance(result.FailureCount)
	default:
		return result, invalid("An inconclusive outcome cannot validate an appendix.")
	}
	if err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	ok, err := dao.InsertAppendixValidation(ctx, model.AssistantTaskAppendixValidation{OwnerUserID: task.OwnerUserID, TaskID: task.ID, AppendixID: result.ID, OutcomeRecordID: record.ID, Outcome: *record.Outcome, ValidatorBotID: *actor.BotID, CreatedAt: now})
	if err != nil {
		return result, err
	}
	if !ok {
		return result, fault("operation_conflict", "The outcome record already validates this appendix.")
	}
	result.LastValidatedAt = &now
	// Validations leave the appendix Version unchanged: it counts revisions of
	// the appendix content, which a validation does not alter.
	ok, err = dao.SaveAppendix(ctx, result, result.Version)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, conflict()
	}
	return result, finishWork(ctx, dao, actor, task, now)
}
