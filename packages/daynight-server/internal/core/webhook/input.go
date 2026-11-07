package webhook

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type Operation struct {
	ID             string `json:"operationId"`
	IssuedAt       string `json:"issuedAt"`
	ExpectedUserID string `json:"expectedUserId"`
	RequestSHA256  string `json:"-"`
}

type SubscriptionInput struct {
	ID         *string  `json:"id"`
	ProjectID  string   `json:"projectId"`
	EventTypes []string `json:"eventTypes"`
}

type CreateInput struct {
	Operation
	Name          string                   `json:"name"`
	Enabled       bool                     `json:"enabled"`
	Destination   webhookmodel.Destination `json:"destination"`
	Subscriptions []SubscriptionInput      `json:"subscriptions"`
}

type PatchInput struct {
	Operation
	IfVersion         int64                     `json:"ifVersion"`
	Name              *string                   `json:"name,omitempty"`
	Enabled           *bool                     `json:"enabled,omitempty"`
	Destination       *webhookmodel.Destination `json:"destination,omitempty"`
	Subscriptions     *[]SubscriptionInput      `json:"subscriptions,omitempty"`
	ConfirmProjectIDs []string                  `json:"confirmProjectIds,omitempty"`
}

type DeleteInput struct {
	Operation
	IfVersion int64 `json:"ifVersion"`
}

type RotateInput struct {
	Operation
	IfVersion int64  `json:"ifVersion"`
	Mode      string `json:"mode"`
}

func fault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func invalid(message string) error     { return fault("invalid_input", message) }

func canonicalID(value string) error {
	canonical, err := model.CanonicalID(value)
	if err != nil || canonical != value || canonical == "00000000-0000-0000-0000-000000000000" {
		return invalid("Webhook IDs must be canonical nonzero UUID strings.")
	}
	return nil
}

func ValidateOwner(owner webhookmodel.Owner) error {
	if owner.Kind != webhookmodel.PersonalOwner && owner.Kind != webhookmodel.TeamOwner {
		return invalid("Webhook owner must be personal or team.")
	}
	return canonicalID(owner.ID)
}

func ParseVersion(value string) (int64, error) {
	version, err := strconv.ParseInt(value, 10, 64)
	if err != nil || version <= 0 || strconv.FormatInt(version, 10) != value {
		return 0, invalid("Webhook versions must be canonical positive int64 decimal strings.")
	}
	return version, nil
}

var utcTimestamp = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|\+00:00)$`)

func operationTime(value string) (time.Time, error) {
	if !utcTimestamp.MatchString(value) {
		return time.Time{}, invalid("issuedAt must be a UTC RFC3339 timestamp with at most nanosecond precision.")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, invalid("issuedAt must be a UTC RFC3339 timestamp.")
	}
	_, offset := parsed.Zone()
	if offset != 0 {
		return time.Time{}, invalid("issuedAt must be a UTC RFC3339 timestamp.")
	}
	return parsed.UTC(), nil
}

func ValidateOperation(operation Operation) error {
	if err := canonicalID(operation.ID); err != nil {
		return err
	}
	if err := canonicalID(operation.ExpectedUserID); err != nil {
		return err
	}
	if _, err := operationTime(operation.IssuedAt); err != nil {
		return err
	}
	decoded, err := hex.DecodeString(operation.RequestSHA256)
	if err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != operation.RequestSHA256 {
		return invalid("The actual request SHA-256 must be lowercase hexadecimal.")
	}
	return nil
}

func CheckOperationTime(operation Operation, now time.Time, policy webhookmodel.Policy) error {
	issued, err := operationTime(operation.IssuedAt)
	if err != nil {
		return err
	}
	if issued.After(now.Add(time.Duration(policy.OperationFutureSkewSeconds) * time.Second)) {
		return fault("invalid_operation_time", "The operation timestamp is too far in the future.")
	}
	if issued.Before(now.Add(-time.Duration(policy.OperationMaxAgeSeconds) * time.Second)) {
		return fault("operation_expired", "The operation can no longer be applied for the first time.")
	}
	return nil
}

func normalizeName(value string) (string, error) {
	if !utf8.ValidString(value) || strings.ContainsFunc(value, unicode.IsControl) {
		return "", invalid("Webhook name must be Unicode without control characters.")
	}
	value = strings.TrimSpace(value)
	if count := utf8.RuneCountInString(value); count < 1 || count > 120 {
		return "", invalid("Webhook name must contain 1 to 120 characters.")
	}
	return value, nil
}

func ValidateDestination(destination webhookmodel.Destination) error {
	if destination.Kind != "http" || destination.AdapterVersion != 1 {
		return fault("destination_unsupported", "The destination type or adapter version is not supported.")
	}
	value := destination.Configuration.URL
	if !utf8.ValidString(value) || strings.ContainsFunc(value, unicode.IsControl) {
		return invalid("Webhook destination must be a valid HTTPS URL.")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Opaque != "" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || strings.Contains(value, "#") {
		return invalid("Webhook destination must be HTTPS without userinfo or fragments.")
	}
	if len(parsed.String()) > 4<<10 {
		return invalid("Webhook destination exceeds the 4 KiB URL limit.")
	}
	if strings.HasSuffix(parsed.Host, ":") {
		return invalid("Webhook destination cannot contain an empty port.")
	}
	if port := parsed.Port(); port != "" {
		value, err := strconv.ParseUint(port, 10, 16)
		if err != nil || value == 0 {
			return invalid("Webhook destination port must be in the range 1 to 65535.")
		}
	}
	return nil
}

func DestinationOrigin(destination webhookmodel.Destination) (string, error) {
	if err := ValidateDestination(destination); err != nil {
		return "", err
	}
	parsed, err := url.Parse(destination.Configuration.URL)
	if err != nil {
		return "", err
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func normalizeSubscriptions(input []SubscriptionInput) ([]SubscriptionInput, error) {
	if len(input) > 50 {
		return nil, fault("subscription_capacity", "An endpoint can have at most 50 subscriptions.")
	}
	result := make([]SubscriptionInput, len(input))
	ids := make(map[string]struct{}, len(input))
	for i, subscription := range input {
		if err := canonicalID(subscription.ProjectID); err != nil {
			return nil, err
		}
		if subscription.ID != nil {
			if err := canonicalID(*subscription.ID); err != nil {
				return nil, err
			}
			if _, found := ids[*subscription.ID]; found {
				return nil, invalid("A subscription ID cannot be repeated.")
			}
			ids[*subscription.ID] = struct{}{}
		}
		if len(subscription.EventTypes) < 1 || len(subscription.EventTypes) > 6 {
			return nil, invalid("A subscription must select 1 to 6 registered event types.")
		}
		keys := slices.Clone(subscription.EventTypes)
		slices.Sort(keys)
		for j, key := range keys {
			if !RegisteredEvent(key) || j > 0 && key == keys[j-1] {
				return nil, invalid("Event selections must contain distinct registered event types.")
			}
		}
		result[i] = SubscriptionInput{ID: subscription.ID, ProjectID: subscription.ProjectID, EventTypes: keys}
	}
	// Subscription row order has no effect; identities and duplicate rows do.
	slices.SortStableFunc(result, func(a, b SubscriptionInput) int {
		left, right := "", ""
		if a.ID != nil {
			left = *a.ID
		}
		if b.ID != nil {
			right = *b.ID
		}
		if comparison := strings.Compare(left, right); comparison != 0 {
			return comparison
		}
		if comparison := strings.Compare(a.ProjectID, b.ProjectID); comparison != 0 {
			return comparison
		}
		return strings.Compare(strings.Join(a.EventTypes, "\x00"), strings.Join(b.EventTypes, "\x00"))
	})
	return result, nil
}

func NormalizeCreate(input CreateInput) (CreateInput, error) {
	if err := ValidateOperation(input.Operation); err != nil {
		return input, err
	}
	name, err := normalizeName(input.Name)
	if err != nil {
		return input, err
	}
	input.Name = name
	if err := ValidateDestination(input.Destination); err != nil {
		return input, err
	}
	if input.Subscriptions == nil {
		return input, invalid("subscriptions must be an explicit array.")
	}
	input.Subscriptions, err = normalizeSubscriptions(input.Subscriptions)
	if err != nil {
		return input, err
	}
	for _, subscription := range input.Subscriptions {
		if subscription.ID != nil {
			return input, invalid("New endpoints cannot use existing subscription IDs.")
		}
	}
	return input, nil
}

func NormalizePatch(input PatchInput) (PatchInput, error) {
	if err := ValidateOperation(input.Operation); err != nil {
		return input, err
	}
	if input.IfVersion <= 0 {
		return input, invalid("ifVersion must be a positive int64.")
	}
	if input.Name == nil && input.Enabled == nil && input.Destination == nil && input.Subscriptions == nil && input.ConfirmProjectIDs == nil {
		return input, invalid("A patch must provide a configuration field.")
	}
	if input.Name != nil {
		name, err := normalizeName(*input.Name)
		if err != nil {
			return input, err
		}
		input.Name = &name
	}
	if input.Destination != nil {
		if err := ValidateDestination(*input.Destination); err != nil {
			return input, err
		}
	}
	if input.Subscriptions != nil {
		if *input.Subscriptions == nil {
			return input, invalid("subscriptions must be an explicit array.")
		}
		normalized, err := normalizeSubscriptions(*input.Subscriptions)
		if err != nil {
			return input, err
		}
		input.Subscriptions = &normalized
	}
	if input.ConfirmProjectIDs != nil {
		input.ConfirmProjectIDs = slices.Clone(input.ConfirmProjectIDs)
		slices.Sort(input.ConfirmProjectIDs)
		for i, id := range input.ConfirmProjectIDs {
			if err := canonicalID(id); err != nil {
				return input, err
			}
			if i > 0 && input.ConfirmProjectIDs[i-1] == id {
				return input, invalid("A confirmation project cannot be repeated.")
			}
		}
	}
	return input, nil
}

func NormalizeDelete(input DeleteInput) (DeleteInput, error) {
	if err := ValidateOperation(input.Operation); err != nil {
		return input, err
	}
	if input.IfVersion <= 0 {
		return input, invalid("ifVersion must be a positive int64.")
	}
	return input, nil
}

func NormalizeRotation(input RotateInput) (RotateInput, error) {
	if err := ValidateOperation(input.Operation); err != nil {
		return input, err
	}
	if input.IfVersion <= 0 || input.Mode != "overlap" && input.Mode != "immediate" {
		return input, invalid("Rotation requires a positive ifVersion and overlap or immediate mode.")
	}
	return input, nil
}

func ValidatePolicy(policy webhookmodel.Policy) error {
	if policy != webhookmodel.DefaultPolicy() {
		return fmt.Errorf("unsupported or corrupt Webhook policy")
	}
	return nil
}
