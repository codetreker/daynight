package assistanttask

import (
	"cmp"
	"context"
	"errors"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Scope sets stay small enough to render in every appendix read and to match
// against a notification without a separate index.
const (
	MaxAppendixScopeEntries  = 20
	MaxAppendixCategoryBytes = 200
)

// MaxRelatedAppendices bounds a related experience query so a notification
// can carry its summaries without paging.
const MaxRelatedAppendices = 5

func appendixCategoryValid(value string) bool {
	return textValid(value, true) && len(value) <= MaxAppendixCategoryBytes
}

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
		{scope.ItemCategories, &result.ItemCategories, appendixCategoryValid},
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

// RelatedAppendixMatch states the related experience rule for one appendix
// scope. A queried dimension whose declared set contains the value scores one
// point; an undeclared dimension or an omitted query value is neutral; a
// declared set without the queried value excludes the appendix. Item
// categories compare verbatim. The DAO's related appendix query executes this
// rule in SQL so a task's appendix set is never materialized; its Store test
// checks that the query result agrees with this function.
func RelatedAppendixMatch(scope model.AssistantTaskAppendixScope, input RelatedAppendixInput) (score int, ok bool) {
	dimensions := []struct {
		declared []string
		queried  string
	}{
		{scope.ProjectIDs, input.ProjectID},
		{scope.EventTypes, input.EventType},
		{scope.ItemCategories, input.ItemCategory},
	}
	for _, dimension := range dimensions {
		if dimension.queried == "" || len(dimension.declared) == 0 {
			continue
		}
		if !slices.Contains(dimension.declared, dimension.queried) {
			return 0, false
		}
		score++
	}
	return score, true
}

// CompareRelatedAppendices orders two matching appendices for a related
// experience query: higher RelatedAppendixMatch score first, then the most
// recent last validation with never-validated appendices last, then the
// greater canonical ID. The DAO's SQL ordering implements this comparison.
func CompareRelatedAppendices(a, b model.AssistantTaskAppendix, input RelatedAppendixInput) int {
	scoreA, _ := RelatedAppendixMatch(a.Scope, input)
	scoreB, _ := RelatedAppendixMatch(b.Scope, input)
	if order := cmp.Compare(scoreB, scoreA); order != 0 {
		return order
	}
	switch {
	case a.LastValidatedAt == nil && b.LastValidatedAt != nil:
		return 1
	case a.LastValidatedAt != nil && b.LastValidatedAt == nil:
		return -1
	case a.LastValidatedAt != nil:
		if order := b.LastValidatedAt.Compare(*a.LastValidatedAt); order != 0 {
			return order
		}
	}
	return cmp.Compare(b.ID, a.ID)
}

// RelatedAppendix reads the non-deleted appendices of a task that apply to a
// notification context under RelatedAppendixMatch, ordered by
// CompareRelatedAppendices and bounded by MaxRelatedAppendices. The database
// ranks the appendices, so the query never materializes a task's full appendix
// set.
func (m *Module) RelatedAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input RelatedAppendixInput) (model.AssistantTaskRelatedAppendices, error) {
	actor = actor.requiringBranches("RelatedAppendix", "default")
	result := model.AssistantTaskRelatedAppendices{Items: []model.AssistantTaskAppendix{}}
	if input.ProjectID != "" && !strictID(input.ProjectID) || input.EventType != "" && !knownEventType(input.EventType) || input.ItemCategory != "" && !appendixCategoryValid(input.ItemCategory) {
		return result, invalid("Related appendix queries require a canonical project ID, a known event type and a nonblank item category of at most 200 bytes when given.")
	}
	task, err := loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return result, err
	}
	items, err := dao.RelatedAppendices(ctx, store.AssistantTaskRelatedQuery{OwnerUserID: task.OwnerUserID, TaskID: task.ID, ProjectID: input.ProjectID, EventType: input.EventType, ItemCategory: input.ItemCategory, Limit: MaxRelatedAppendices})
	if err != nil {
		return result, err
	}
	result.Items = append(result.Items, items...)
	result.ObservedAt, err = finish(ctx, dao, actor, nil)
	return result, err
}

// ValidateAppendix registers one same-task outcome record as evidence for an
// appendix. Only the responsible Bot may validate; an effective outcome counts
// as a success, an ineffective one as a failure and an inconclusive one is
// refused. The registration is unique per outcome record and appendix, and the
// counts change in the same transaction as the registration.
func (m *Module) ValidateAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input AppendixValidationInput) (model.AssistantTaskAppendix, error) {
	actor = actor.requiringBranches("ValidateAppendix", "default")
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
