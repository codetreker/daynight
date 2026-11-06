// Package mcptransfer owns rules for private transfer records and their lifecycle.
package mcptransfer

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

const (
	IdleLifetime    = time.Hour
	MaximumLifetime = 24 * time.Hour
	Retention       = 24 * time.Hour
)

var (
	ErrConflict = &model.Fault{Code: "transfer_conflict", Message: "Transfer binding does not match."}
	ErrCapacity = &model.Fault{Code: "capacity_unavailable", Message: "Temporary capacity is unavailable."}
	ErrState    = &model.Fault{Code: "transfer_state_conflict", Message: "Transfer state does not permit this operation."}
)

type Actor struct {
	Principal                  model.Principal
	AuthorityKind, AuthorityID string
}

type Binding struct {
	ID, Direction, ProjectID, TaskID, Path, ContentType string
	Parameters                                          json.RawMessage
}

func Canonical(id string) bool {
	u, err := uuid.Parse(id)
	return err == nil && u != uuid.Nil && u.String() == id
}
func ValidateActor(a Actor) error {
	if err := model.RequirePrincipal(a.Principal); err != nil {
		return err
	}
	if !Canonical(a.Principal.UserID) || !Canonical(a.Principal.CredentialID) || !Canonical(a.AuthorityID) {
		return ErrConflict
	}
	if (a.AuthorityKind == "pat" && (a.Principal.Kind != model.PATCredential || a.AuthorityID != a.Principal.CredentialID)) || (a.AuthorityKind == "oauth" && a.Principal.Kind != model.OAuthCredential) || (a.AuthorityKind != "pat" && a.AuthorityKind != "oauth") {
		return ErrConflict
	}
	return nil
}
func NormalizeJSON(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var value any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, errors.New("invalid JSON")
	}
	return json.Marshal(value)
}
func SameBinding(r model.PrivateTransfer, a Actor, b Binding, params json.RawMessage) bool {
	var stored, given any
	decode := func(raw []byte, result *any) error {
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		return d.Decode(result)
	}
	if decode(r.Binding, &stored) != nil || decode(params, &given) != nil {
		return false
	}
	return r.ID == b.ID && r.UserID == a.Principal.UserID && r.AuthorityKind == a.AuthorityKind && r.AuthorityID == a.AuthorityID && r.Direction == b.Direction && r.ProjectID == b.ProjectID && r.TaskID == b.TaskID && r.Path == b.Path && r.ContentType == b.ContentType && EqualJSON(stored, given)
}
func EqualJSON(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		left, ok := canonicalNumber(string(x))
		if !ok {
			return false
		}
		right, ok := canonicalNumber(string(y))
		return ok && left == right
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !EqualJSON(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			other, exists := y[k]
			if !exists || !EqualJSON(v, other) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}

type numberKey struct {
	digits   string
	exponent int64
}

// Compare decimal numbers without expanding the exponent into a giant integer.
func canonicalNumber(value string) (numberKey, bool) {
	mantissa, exponentText, hasExponent := strings.Cut(strings.ToLower(value), "e")
	negative := strings.HasPrefix(mantissa, "-")
	mantissa = strings.TrimPrefix(mantissa, "-")
	whole, fraction, _ := strings.Cut(mantissa, ".")
	digits := strings.TrimLeft(whole+fraction, "0")
	if digits == "" {
		return numberKey{digits: "0"}, true
	}
	var exponent int64
	if hasExponent {
		var err error
		exponent, err = strconv.ParseInt(exponentText, 10, 64)
		if err != nil {
			return numberKey{}, false
		}
	}
	if exponent < math.MinInt64+int64(len(fraction)) {
		return numberKey{}, false
	}
	exponent -= int64(len(fraction))
	trimmed := strings.TrimRight(digits, "0")
	zeros := int64(len(digits) - len(trimmed))
	if exponent > math.MaxInt64-zeros {
		return numberKey{}, false
	}
	exponent += zeros
	if negative {
		trimmed = "-" + trimmed
	}
	return numberKey{digits: trimmed, exponent: exponent}, true
}
func Live(r model.PrivateTransfer, now time.Time) bool {
	return r.State != "cleanup_pending" && r.State != "closed" && now.Before(r.ExpiresAt) && now.Before(r.HardExpiresAt)
}
func ContentState(state string) bool {
	return state == "receiving" || state == "preparing" || state == "readable" || state == "committing"
}

func OperationID(data json.RawMessage) string {
	var value struct {
		OperationID string `json:"operationId"`
	}
	if json.Unmarshal(data, &value) != nil {
		return ""
	}
	return value.OperationID
}

func Allowed(from, to string) bool {
	switch from {
	case "receiving":
		return to == "receiving" || to == "committing"
	case "preparing":
		return to == "preparing" || to == "readable" || to == "failed"
	case "readable":
		return to == "readable"
	case "committing":
		return to == "committing" || to == "committed" || to == "failed" || to == "unknown"
	case "unknown":
		return to == "unknown" || to == "committed" || to == "failed"
	default:
		return false
	}
}

// Transition validates and constructs the state written under the transfer lock.
func Transition(r model.PrivateTransfer, version int64, state string, data json.RawMessage, leaseUntil *time.Time, now time.Time) (model.PrivateTransfer, error) {
	if !Live(r, now) || r.Version != version || !Allowed(r.State, state) {
		return r, ErrState
	}
	if state == "committing" && (!Canonical(OperationID(data)) || leaseUntil == nil || !leaseUntil.After(now) || leaseUntil.After(now.Add(time.Minute))) {
		return r, ErrState
	}
	if (r.State == "committing" || r.State == "unknown") && (!Canonical(OperationID(r.Data)) || OperationID(r.Data) != OperationID(data)) {
		return r, ErrState
	}
	r.State, r.Data, r.LeaseUntil, r.UpdatedAt = state, data, leaseUntil, now
	return Renew(r, now), nil
}

func Renew(r model.PrivateTransfer, now time.Time) model.PrivateTransfer {
	r.ExpiresAt = now.Add(IdleLifetime)
	if r.ExpiresAt.After(r.HardExpiresAt) {
		r.ExpiresAt = r.HardExpiresAt
	}
	return r
}

// FinishCommit records only a fact for the same operation. Pending cleanup is
// retained so an external result cannot reopen the namespace.
func FinishCommit(r model.PrivateTransfer, version int64, state string, data json.RawMessage) (model.PrivateTransfer, bool, error) {
	if state != "committed" && state != "failed" {
		return r, false, ErrState
	}
	if (version != 0 && r.Version != version) || !Canonical(OperationID(r.Data)) || OperationID(r.Data) != OperationID(data) {
		return r, false, ErrState
	}
	r.Data = data
	if r.State == "cleanup_pending" {
		if r.CleanupFromState == nil || (*r.CleanupFromState != "unknown" && *r.CleanupFromState != "committing") {
			return r, false, ErrState
		}
		r.CleanupFromState = &state
		return r, true, nil
	}
	if r.State != "committing" && r.State != "unknown" {
		return r, false, ErrState
	}
	r.State, r.LeaseUntil = state, nil
	return r, false, nil
}

// CleanupSteps retains the intermediate unknown write required for a committing
// operation; both changes must be persisted in the same locked transaction.
func CleanupSteps(r model.PrivateTransfer, now time.Time, dueOnly bool) []model.PrivateTransfer {
	if r.State == "closed" || r.State == "cleanup_pending" {
		return nil
	}
	if dueOnly {
		if r.LeaseUntil != nil && now.Before(*r.LeaseUntil) {
			return nil
		}
		leaseExpired := r.State == "committing" && (r.LeaseUntil == nil || !now.Before(*r.LeaseUntil))
		if !leaseExpired && now.Before(r.ExpiresAt) && now.Before(r.HardExpiresAt) {
			return nil
		}
	}
	var result []model.PrivateTransfer
	if r.State == "committing" {
		r.State, r.LeaseUntil = "unknown", nil
		result = append(result, r)
	}
	r.State, r.UpdatedAt = "cleanup_pending", now
	return append(result, r)
}

func CapacityAvailable(free, reservedFree, outstanding, additional int64) bool {
	return free >= reservedFree && outstanding <= free-reservedFree && additional <= free-reservedFree-outstanding
}

func InitialValid(t model.PrivateTransfer) bool {
	return t.ReservedBytes == 0 && t.OutstandingBytes == 0 && t.State != "closed" && t.State != "cleanup_pending"
}
func ActiveLimitExceeded(active int) bool { return active > 4 }
func ReservationValid(t model.PrivateTransfer, additional, budget, total int64) bool {
	return total <= budget && additional <= budget-total && additional <= math.MaxInt64-t.ReservedBytes && additional <= math.MaxInt64-t.OutstandingBytes
}

// NewRecord prepares the immutable binding and initial lifecycle before insertion.
func NewRecord(a Actor, b Binding, now time.Time) (model.PrivateTransfer, error) {
	if !Canonical(b.ID) || !Canonical(b.ProjectID) || !Canonical(b.TaskID) || (b.Direction != "upload" && b.Direction != "download") {
		return model.PrivateTransfer{}, ErrConflict
	}
	params, err := NormalizeJSON(b.Parameters)
	if err != nil {
		return model.PrivateTransfer{}, ErrConflict
	}
	state := "receiving"
	if b.Direction == "download" {
		state = "preparing"
	}
	return model.PrivateTransfer{ID: b.ID, UserID: a.Principal.UserID, AuthorityKind: a.AuthorityKind, AuthorityID: a.AuthorityID, Direction: b.Direction, ProjectID: b.ProjectID, TaskID: b.TaskID, Path: b.Path, ContentType: b.ContentType, Binding: params, Data: json.RawMessage(`{}`), State: state, CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(IdleLifetime), HardExpiresAt: now.Add(MaximumLifetime)}, nil
}

func OwnedBy(r model.PrivateTransfer, a Actor) bool {
	return r.UserID == a.Principal.UserID && r.AuthorityKind == a.AuthorityKind && r.AuthorityID == a.AuthorityID
}
func FinishStateValid(state string) bool { return state == "committed" || state == "failed" }
func ReservationStateValid(r model.PrivateTransfer) bool {
	return r.State != "closed" && r.State != "cleanup_pending"
}
func ConsumptionValid(r model.PrivateTransfer, expected, amount int64) bool {
	return r.Version == expected && ReservationStateValid(r) && amount <= r.OutstandingBytes
}
func CloseValid(r model.PrivateTransfer, expected int64) bool {
	return r.Version == expected && r.State == "cleanup_pending"
}
func PendingOutcomeValid(r model.PrivateTransfer) bool {
	return r.CleanupFromState != nil && *r.CleanupFromState != ""
}
func UpdateStateValid(r model.PrivateTransfer) bool { return r.State != "closed" }

func PendingCleanup(r model.PrivateTransfer) bool { return r.State == "cleanup_pending" }
