package codec

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const MaxEncodedBytes = 64 * 1024 * 1024

// MaxMCPStepCursorBytes is the existing encoded Step list cursor limit.
const MaxMCPStepCursorBytes = 2048

type Step struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Status      model.TaskStepStatus `json:"status"`
	CreatedAt   time.Time            `json:"createdAt"`
	UpdatedAt   time.Time            `json:"updatedAt"`
}

type StepsResource struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Version   int64  `json:"version"`
	Steps     []Step `json:"steps"`
}

type StepResource struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Version   int64  `json:"version"`
	Step      Step   `json:"step"`
}

type LimitError struct {
	EncodedBytes int64
}

func (err *LimitError) Error() string { return "task steps exceed the encoded resource limit" }

func CanonicalID(value string) (string, error) {
	if len(value) != 8 {
		return "", errors.New("step ID must contain exactly eight hexadecimal characters")
	}
	for _, digit := range []byte(value) {
		if !hexDigit(digit) && (digit < 'A' || digit > 'F') {
			return "", errors.New("step ID must contain exactly eight hexadecimal characters")
		}
	}
	return strings.ToLower(value), nil
}

func hexDigit(digit byte) bool {
	return digit >= '0' && digit <= '9' || digit >= 'a' && digit <= 'f'
}

func canonicalUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, digit := range []byte(value) {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if digit != '-' {
				return false
			}
		} else if !hexDigit(digit) {
			return false
		}
	}
	return true
}

func ValidateTitle(title string) error {
	if !utf8.ValidString(title) || strings.ContainsRune(title, 0) || strings.TrimFunc(title, unicode.IsSpace) == "" {
		return errors.New("step title must contain a non-whitespace character in valid UTF-8 without NUL")
	}
	return nil
}

func ValidateDescription(description string) error {
	if !utf8.ValidString(description) || strings.ContainsRune(description, 0) {
		return errors.New("step description must be valid UTF-8 without NUL")
	}
	return nil
}

func ValidateText(title, description string) error {
	if err := ValidateTitle(title); err != nil {
		return err
	}
	return ValidateDescription(description)
}

func validTime(value time.Time) bool {
	return !value.IsZero() && value.Year() >= 1 && value.Year() <= 9999 && value.Nanosecond()%1000 == 0
}

func ValidateStep(step model.TaskStep) error {
	id, err := CanonicalID(step.ID)
	if err != nil || id != step.ID {
		return errors.New("stored step ID is not canonical")
	}
	if step.Position < 0 {
		return errors.New("stored step position is negative")
	}
	if err := ValidateText(step.Title, step.Description); err != nil {
		return err
	}
	if !step.Status.Valid() {
		return errors.New("stored step status is invalid")
	}
	if !validTime(step.CreatedAt) || !validTime(step.UpdatedAt) {
		return errors.New("stored step timestamp is not a finite microsecond timestamp")
	}
	return nil
}

func ValidateHeader(header model.TaskHeader) error {
	if !canonicalUUID(header.ProjectID) || !canonicalUUID(header.ID) || header.Version < 1 || header.DeletedAt != nil {
		return errors.New("task steps parent header is invalid")
	}
	return nil
}

func publicStep(step model.TaskStep) Step {
	return Step{ID: step.ID, Title: step.Title, Description: step.Description, Status: step.Status,
		CreatedAt: step.CreatedAt.UTC(), UpdatedAt: step.UpdatedAt.UTC()}
}

func Collection(header model.TaskHeader, steps []model.TaskStep) (StepsResource, error) {
	if err := ValidateHeader(header); err != nil {
		return StepsResource{}, err
	}
	if steps == nil {
		return StepsResource{}, errors.New("task steps collection is absent")
	}
	resource := StepsResource{ProjectID: header.ProjectID, TaskID: header.ID, Version: header.Version, Steps: make([]Step, len(steps))}
	ids := make(map[string]struct{}, len(steps))
	for index, step := range steps {
		if err := ValidateStep(step); err != nil {
			return StepsResource{}, fmt.Errorf("invalid stored step at position %d: %w", index, err)
		}
		if step.Position != int64(index) {
			return StepsResource{}, errors.New("stored step positions are not dense and ordered")
		}
		if _, exists := ids[step.ID]; exists {
			return StepsResource{}, errors.New("stored step IDs are not unique")
		}
		ids[step.ID] = struct{}{}
		resource.Steps[index] = publicStep(step)
	}
	return resource, nil
}

func Item(header model.TaskHeader, step model.TaskStep) (StepResource, error) {
	if err := ValidateHeader(header); err != nil {
		return StepResource{}, err
	}
	if err := ValidateStep(step); err != nil {
		return StepResource{}, err
	}
	return StepResource{ProjectID: header.ProjectID, TaskID: header.ID, Version: header.Version, Step: publicStep(step)}, nil
}

// The same Encoder settings and terminal newline define both admission size and
// HTTP output. Reserving 19 version digits keeps valid content readable after
// an unrelated parent update increases the version's decimal width.
func encode(value any, version int64) ([]byte, error) {
	var output bytes.Buffer
	if err := json.NewEncoder(&output).Encode(value); err != nil {
		return nil, err
	}
	if err := checkCapacity(output.Len(), version); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func checkCapacity(encodedBytes int, version int64) error {
	reserved := int64(encodedBytes + 19 - len(strconv.FormatInt(version, 10)))
	if reserved > MaxEncodedBytes {
		return &LimitError{EncodedBytes: reserved}
	}
	return nil
}

func EncodeCollection(header model.TaskHeader, steps []model.TaskStep) (StepsResource, []byte, error) {
	resource, err := Collection(header, steps)
	if err != nil {
		return StepsResource{}, nil, err
	}
	data, err := encode(resource, resource.Version)
	return resource, data, err
}

func EncodeItem(header model.TaskHeader, step model.TaskStep) (StepResource, []byte, error) {
	resource, err := Item(header, step)
	if err != nil {
		return StepResource{}, nil, err
	}
	data, err := encode(resource, resource.Version)
	return resource, data, err
}
