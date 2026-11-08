// Package webhook owns webhook configuration rules independent of HTTP and storage.
package webhook

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

var (
	ErrInvalidInput      = errors.New("invalid webhook input")
	ErrOperationExpired  = errors.New("webhook operation expired")
	ErrOperationInFuture = errors.New("webhook operation is too far in the future")
)

// NormalizeName trims Unicode whitespace and validates the visible name.
func NormalizeName(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrInvalidInput
	}
	name := strings.TrimSpace(value)
	count := utf8.RuneCountInString(name)
	if count < 1 || count > 120 || strings.ContainsFunc(name, unicode.IsControl) {
		return "", ErrInvalidInput
	}
	return name, nil
}

// ValidateURL validates a generic HTTPS destination and returns its safe origin.
// The caller retains the original URL; path and query are never rewritten.
func ValidateURL(value string) (string, error) {
	if !utf8.ValidString(value) || len(value) > 4096 || strings.Contains(value, "#") {
		return "", ErrInvalidInput
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || strings.ContainsFunc(u.Hostname(), func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
		return "", ErrInvalidInput
	}
	// url.Parse preserves RawQuery without validating escapes. Invalid escapes
	// cannot form a usable URL, even though no query normalization is needed.
	if _, err := url.QueryUnescape(u.RawQuery); err != nil {
		return "", ErrInvalidInput
	}
	// String escapes path bytes. Account for any non-ASCII bytes still present
	// in host or query as percent-encoded bytes at the transport boundary.
	encoded := u.String()
	size := 0
	for i := 0; i < len(encoded); i++ {
		if encoded[i] >= 0x80 {
			size += 3
		} else {
			size++
		}
	}
	if size > 4096 {
		return "", ErrInvalidInput
	}
	return u.Scheme + "://" + u.Host, nil
}

// CanonicalUUID accepts only the lowercase, hyphenated UUID form.
func CanonicalUUID(value string) error {
	id, err := uuid.Parse(value)
	if err != nil || id.String() != value {
		return ErrInvalidInput
	}
	return nil
}

// ParseVersion keeps the complete positive int64 decimal value without floats.
func ParseVersion(value string) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != value {
		return 0, ErrInvalidInput
	}
	return n, nil
}

var utcTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$`)

// ParseIssuedAt validates UTC RFC3339 while the caller retains its original
// text for the receipt and fingerprint.
func ParseIssuedAt(value string) (time.Time, error) {
	if !utcTimestamp.MatchString(value) {
		return time.Time{}, ErrInvalidInput
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, ErrInvalidInput
	}
	return t.UTC(), nil
}

// CheckIssuedAt applies only to new intents after receipt lookup. Both bounds
// are inclusive and now must come from the transaction's authoritative clock.
func CheckIssuedAt(issued, now time.Time) error {
	if issued.Before(now.Add(-5 * time.Minute)) {
		return ErrOperationExpired
	}
	if issued.After(now.Add(time.Minute)) {
		return ErrOperationInFuture
	}
	return nil
}

// CheckIssuedAtText preserves sub-nanosecond fractional precision when comparing
// the upper boundary. ParseIssuedAt alone cannot represent those extra digits.
func CheckIssuedAtText(value string, now time.Time) error {
	return CheckIssuedAtLimits(value, now, 300*time.Second, 60*time.Second)
}

// CheckIssuedAtLimits applies the selected policy without losing lexical precision.
func CheckIssuedAtLimits(value string, now time.Time, maxAge, futureSkew time.Duration) error {
	issued, err := ParseIssuedAt(value)
	if err != nil {
		return err
	}
	if issued.Before(now.Add(-maxAge)) {
		return ErrOperationExpired
	}
	if issued.After(now.Add(futureSkew)) {
		return ErrOperationInFuture
	}
	if issued.Equal(now.Add(futureSkew)) {
		fractionStart := strings.IndexByte(value, '.')
		if fractionStart >= 0 {
			fraction := value[fractionStart+1:]
			fraction = strings.TrimSuffix(strings.TrimSuffix(fraction, "Z"), "+00:00")
			if len(fraction) > 9 && strings.Trim(fraction[9:], "0") != "" {
				return ErrOperationInFuture
			}
		}
	}
	return nil
}

// Destination identifies normalized destination inputs, retaining the exact URL.
type Destination struct {
	Kind, AdapterVersion, URL string
}

// SubscriptionInput describes one independently retained project selection.
type SubscriptionInput struct {
	ID         *string
	ProjectID  string
	EventTypes []string
}

// EventTypes is the fixed catalog accepted by configuration and dispatch.
var EventTypes = [...]string{"task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"}

func ValidEventType(value string) bool {
	for _, eventType := range EventTypes {
		if value == eventType {
			return true
		}
	}
	return false
}

// Intent contains all normalized inputs to a T01 mutation. Nil optional fields
// represent omitted fields and remain distinct from provided zero values.
type Intent struct {
	OperationID, ActorID, OwnerKind, OwnerID, Kind, TargetID, IssuedAt string
	IfVersion                                                          *int64
	Name                                                               *string
	Enabled                                                            *bool
	Destination                                                        *Destination
	HasSubscriptions                                                   bool
	Subscriptions                                                      []SubscriptionInput `json:",omitempty"`
	ConfirmProjectIDs                                                  []string            `json:",omitempty"`
	Mode                                                               string
}

// Fingerprint binds semantic intent independently from the hash of wire bytes.
func Fingerprint(intent Intent) (string, error) {
	data, err := json.Marshal(intent)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
