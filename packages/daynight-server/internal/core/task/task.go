package task

import (
	"context"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
)

type CreateTask struct {
	TagIDs                  *[]string
	Type                    model.TaskType
	ParentID                *string
	AssignedToPresent       bool
	RequiredPlatformPresent bool
	Status                  *model.TaskStatus
	AssignedTo              *string
	RequiredPlatform        *model.TaskPlatform
	ExternalDependsOn       []string
	Title                   string
	Description             string
	Properties              model.TaskProperties
	DependsOn               []string
}

type UpdateTask struct {
	TagIDs            *[]string
	ParentID          **string
	AssignedTo        **string
	RequiredPlatform  **model.TaskPlatform
	ExternalDependsOn *[]string
	AllowAgents       *bool
	Version           int64
	Title             *string
	Description       *string
	DependsOn         *[]string
	Properties        model.TaskPropertiesPatch
}

func invalidInput(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }

func PropertyFault(err error) *model.Fault {
	var invalid *taskproperty.ValidationError
	var violation *limit.Violation
	if errors.As(err, &invalid) {
		return &model.Fault{Code: "invalid_input", Message: invalid.Error(), Cause: err}
	}
	if errors.As(err, &violation) {
		return &model.Fault{Code: "invalid_input", Message: violation.Error(), Cause: err}
	}
	return nil
}

func PropertyInputError(err error) error {
	if fault := PropertyFault(err); fault != nil {
		return fault
	}
	return err
}

func NotFound(cause error) *model.Fault {
	if errors.Is(cause, model.ErrTaskDeleted) {
		return &model.Fault{Code: "task_deleted", Message: "Task was deleted.", Cause: cause}
	}
	return &model.Fault{Code: "not_found", Message: "Task was not found.", Cause: cause}
}

func RequireVersion(current, observed int64) error {
	if current != observed {
		return &model.Fault{Code: "version_conflict", Message: "Task version does not match."}
	}
	return nil
}

func CurrentWrite(current model.Task) store.TaskWrite {
	return store.TaskWrite{
		Type: current.Type, ParentID: current.ParentID, AssignedTo: current.AssignedTo, RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents,
		Title: current.Title, Description: current.Description, Properties: taskproperty.Clone(current.Properties),
		Status: current.Status, DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn,
	}
}

func canonicalAssignedTo(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	canonical, err := model.CanonicalID(*value)
	if err != nil {
		return nil, err
	}
	return &canonical, nil
}

func CreateCandidate(id string, input CreateTask) (store.TaskWrite, error) {
	typ := input.Type
	if typ == "" {
		typ = model.TaskTypeTask
	}
	if typ != model.TaskTypeTask && typ != model.TaskTypeGoal {
		return store.TaskWrite{}, invalidInput("Task type must be task or goal.")
	}
	status := model.TaskProposed
	if typ == model.TaskTypeGoal {
		status = model.TaskTodo
	}
	if input.Status != nil {
		status = *input.Status
	}
	if typ == model.TaskTypeTask && status != model.TaskProposed && status != model.TaskTodo {
		return store.TaskWrite{}, invalidInput("New task status must be proposed or todo.")
	}
	if typ == model.TaskTypeGoal && (!status.Valid() || status == model.TaskProposed) {
		return store.TaskWrite{}, invalidInput("Goal status must be todo, in_progress, done or cancelled.")
	}
	if typ == model.TaskTypeGoal && (input.ParentID != nil || len(input.DependsOn) != 0 || len(input.ExternalDependsOn) != 0 || (input.RequiredPlatform != nil || input.RequiredPlatformPresent)) {
		return store.TaskWrite{}, invalidInput("Goal does not support a parent, dependencies or execution platform.")
	}
	if err := CheckPropertiesForType(typ, input.Properties); err != nil {
		return store.TaskWrite{}, err
	}
	parentID, err := canonicalAssignedTo(input.ParentID)
	if err != nil {
		return store.TaskWrite{}, err
	}
	if err := AdmitDependencies(input.DependsOn); err != nil {
		return store.TaskWrite{}, PropertyInputError(err)
	}
	props, err := properties.Normalize(input.Properties)
	if err != nil {
		return store.TaskWrite{}, PropertyInputError(err)
	}
	assignedTo, err := canonicalAssignedTo(input.AssignedTo)
	if err != nil {
		return store.TaskWrite{}, err
	}
	values := store.TaskWrite{Type: typ, ParentID: parentID, AssignedTo: assignedTo, RequiredPlatform: input.RequiredPlatform, AllowAgents: false, Title: input.Title, Description: input.Description, Status: status, Properties: props}
	values.DependsOn, err = canonicalDependencies(input.DependsOn, id)
	if err != nil {
		return store.TaskWrite{}, err
	}
	values.ExternalDependsOn, err = canonicalExternalDependencies(input.ExternalDependsOn, id, values.DependsOn)
	if err != nil {
		return store.TaskWrite{}, err
	}
	return values, validateTaskValues(values)
}

func ValidateUpdateFields(input UpdateTask) error {
	if input.ParentID == nil && input.Title == nil && input.Description == nil && input.DependsOn == nil && input.ExternalDependsOn == nil && len(input.Properties) == 0 && input.AllowAgents == nil && input.RequiredPlatform == nil && input.AssignedTo == nil {
		return invalidInput("At least one task field must be provided.")
	}
	return nil
}

func UpdateCandidate(current model.Task, input UpdateTask) (store.TaskWrite, error) {
	values := CurrentWrite(current)
	if current.Type == model.TaskTypeGoal && ((input.ParentID != nil && *input.ParentID != nil) || input.DependsOn != nil || input.ExternalDependsOn != nil || input.AllowAgents != nil || input.RequiredPlatform != nil) {
		return store.TaskWrite{}, invalidInput("Goal does not support parent, dependencies or execution fields.")
	}
	if err := CheckPropertiesForType(current.Type, input.Properties); err != nil {
		return store.TaskWrite{}, err
	}
	if input.ParentID != nil {
		var err error
		values.ParentID, err = canonicalAssignedTo(*input.ParentID)
		if err != nil {
			return store.TaskWrite{}, err
		}
	}
	if input.AssignedTo != nil {
		var err error
		values.AssignedTo, err = canonicalAssignedTo(*input.AssignedTo)
		if err != nil {
			return store.TaskWrite{}, err
		}
	}
	if input.RequiredPlatform != nil {
		values.RequiredPlatform = *input.RequiredPlatform
	}
	if input.AllowAgents != nil {
		values.AllowAgents = *input.AllowAgents
	}
	if input.Title != nil {
		values.Title = *input.Title
	}
	if input.Description != nil {
		values.Description = *input.Description
	}
	if input.DependsOn != nil {
		if err := AdmitDependencies(*input.DependsOn); err != nil {
			return store.TaskWrite{}, PropertyInputError(err)
		}
		var err error
		values.DependsOn, err = canonicalDependencies(*input.DependsOn, current.ID)
		if err != nil {
			return store.TaskWrite{}, err
		}
		values.ExternalDependsOn = slices.DeleteFunc(slices.Clone(current.ExternalDependsOn), func(id string) bool { return !slices.Contains(values.DependsOn, id) })
	}
	if input.ExternalDependsOn != nil {
		var err error
		values.ExternalDependsOn, err = canonicalExternalDependencies(*input.ExternalDependsOn, current.ID, values.DependsOn)
		if err != nil {
			return store.TaskWrite{}, err
		}
	}
	props, err := properties.Normalize(input.Properties)
	if err != nil {
		return store.TaskWrite{}, PropertyInputError(err)
	}
	for name, value := range props {
		values.Properties[name] = value
	}
	if err := validateTaskValues(values); err != nil {
		return store.TaskWrite{}, err
	}
	return values, nil
}

func ValidateUpdate(current model.Task, values store.TaskWrite) error {
	if current.AllowAgents != values.AllowAgents && current.Status == model.TaskInProgress {
		return &model.Fault{Code: "invalid_transition", Message: "Automatic execution permission cannot change while the task is in progress."}
	}
	if !model.EqualOptional(current.RequiredPlatform, values.RequiredPlatform) && current.Status == model.TaskInProgress {
		return &model.Fault{Code: "invalid_transition", Message: "Execution platform cannot change while the task is in progress."}
	}
	return nil
}

func Changed(current model.Task, values store.TaskWrite) bool {
	return !model.EqualOptional(current.ParentID, values.ParentID) || !model.EqualOptional(current.AssignedTo, values.AssignedTo) || !model.EqualOptional(current.RequiredPlatform, values.RequiredPlatform) || current.AllowAgents != values.AllowAgents || current.Title != values.Title || current.Description != values.Description ||
		!slices.Equal(current.DependsOn, values.DependsOn) || !slices.Equal(current.ExternalDependsOn, values.ExternalDependsOn) || !taskproperty.Equal(current.Properties, values.Properties)
}

func validateTaskValues(values store.TaskWrite) error {
	if values.RequiredPlatform != nil && !values.RequiredPlatform.Valid() {
		return invalidInput("Execution platform must be windows, linux, macos or null.")
	}
	if strings.TrimSpace(values.Title) == "" || !utf8.ValidString(values.Title) || strings.ContainsRune(values.Title, 0) {
		return invalidInput("Task title must be nonempty UTF-8 text without NUL characters.")
	}
	if !utf8.ValidString(values.Description) || strings.ContainsRune(values.Description, 0) {
		return invalidInput("Task description must be UTF-8 text without NUL characters.")
	}
	if err := text.Admit(values.Title, values.Description); err != nil {
		return PropertyInputError(err)
	}
	if err := AdmitDependencies(values.DependsOn); err != nil {
		return PropertyInputError(err)
	}
	return nil
}

func canonicalDependencies(ids []string, self string) ([]string, error) {
	canonical := make([]string, 0, len(ids))
	for _, id := range ids {
		id, err := model.CanonicalID(id)
		if err != nil {
			return nil, err
		}
		canonical = append(canonical, id)
	}
	slices.Sort(canonical)
	for index, id := range canonical {
		if id == self {
			return nil, &model.Fault{Code: "invalid_input", Message: "Task cannot depend on itself.", TaskIDs: []string{id}}
		}
		if index > 0 && id == canonical[index-1] {
			return nil, &model.Fault{Code: "invalid_input", Message: "Task dependencies must not repeat.", TaskIDs: []string{id}}
		}
	}
	return canonical, nil
}

func canonicalExternalDependencies(ids []string, self string, dependencies []string) ([]string, error) {
	// A unique subset of an admitted complete set cannot exceed this bound.
	// Reject it before allocating or canonicalizing the supplied identifiers.
	if len(ids) > MaxDependencies {
		return nil, invalidInput("External dependencies must belong to the complete dependency set.")
	}
	canonical, err := canonicalDependencies(ids, self)
	if err != nil {
		return nil, err
	}
	outside := make([]string, 0)
	for _, id := range canonical {
		if !slices.Contains(dependencies, id) {
			outside = append(outside, id)
		}
	}
	if len(outside) > 0 {
		return nil, &model.Fault{Code: "invalid_input", Message: "External dependencies must belong to the complete dependency set.", TaskIDs: outside}
	}
	return canonical, nil
}

func ValidateCandidate(ctx context.Context, dao store.TaskWriteDAO, id string, values store.TaskWrite) error {
	if err := ValidateParent(ctx, dao, values.ParentID); err != nil {
		return err
	}
	return validateCandidate(ctx, dao, id, values, nil)
}

// ValidateParent is called under the Project write lock, so it observes the
// same serialization order as Goal deletion, status changes, and claims.
func ValidateParent(ctx context.Context, dao store.TaskWriteDAO, parentID *string) error {
	if parentID == nil {
		return nil
	}
	parent, err := dao.ParentTask(ctx, *parentID)
	if errors.Is(err, model.ErrNotFound) || errors.Is(err, model.ErrTaskDeleted) {
		return invalidInput("Parent must identify a visible Goal in this project.")
	}
	if err != nil {
		return err
	}
	if parent.Type != model.TaskTypeGoal || parent.ParentID != nil {
		return invalidInput("Parent must identify a visible Goal in this project.")
	}
	return nil
}

func validateCandidate(ctx context.Context, dao store.TaskWriteDAO, id string, values store.TaskWrite, retained []string) error {
	if values.Type == model.TaskTypeGoal {
		return nil
	}
	if err := AdmitDependencies(values.DependsOn); err != nil {
		return PropertyInputError(err)
	}
	prerequisites, err := dao.TasksByID(ctx, values.DependsOn)
	if err != nil {
		return err
	}
	known := make(map[string]bool, len(prerequisites))
	for _, prerequisite := range prerequisites {
		known[prerequisite.ID] = true
	}
	missing := make([]string, 0)
	for _, dependency := range values.DependsOn {
		if !known[dependency] {
			missing = append(missing, dependency)
		}
	}
	if len(missing) > 0 {
		return &model.Fault{Code: "invalid_input", Message: "Dependencies must identify tasks in this project.", TaskIDs: missing}
	}
	added := make([]string, 0, len(values.DependsOn))
	for _, dependency := range values.DependsOn {
		if !slices.Contains(retained, dependency) {
			added = append(added, dependency)
		}
	}
	if len(added) > 0 {
		visible, err := dao.VisibleTaskIDs(ctx, added)
		if err != nil {
			return err
		}
		missing = missing[:0]
		for _, dependency := range added {
			if !slices.Contains(visible, dependency) {
				missing = append(missing, dependency)
			}
		}
		if len(missing) > 0 {
			return &model.Fault{Code: "invalid_input", Message: "Dependencies must identify visible tasks in this project.", TaskIDs: missing}
		}
	}
	cycles := make([]string, 0)
	for _, dependency := range values.DependsOn {
		reachable, err := dao.Reachable(ctx, dependency, id, store.DependencyReplacement{TaskID: id, DependsOn: values.DependsOn})
		if err != nil {
			return err
		}
		if reachable {
			cycles = append(cycles, dependency)
		}
	}
	if len(cycles) > 0 {
		return &model.Fault{Code: "dependency_cycle", Message: "Task dependencies would create a cycle.", TaskIDs: cycles}
	}
	if values.Status.RequiresSatisfiedPrerequisites() {
		blocked := make([]string, 0)
		for _, prerequisite := range prerequisites {
			if !prerequisite.Status.SatisfiesDependency() {
				blocked = append(blocked, prerequisite.ID)
			}
		}
		if len(blocked) > 0 {
			slices.Sort(blocked)
			return &model.Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done or cancelled.", TaskIDs: blocked}
		}
	}
	return nil
}
