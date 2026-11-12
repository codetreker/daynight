// Package credentialusage owns bounded sampling rules for successful credential use.
package credentialusage

import (
	"errors"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// Source identifies the trusted successful-use boundary without retaining request data.
type Source uint8

const (
	SourceHTTPPAT Source = iota + 1
	SourceMCPPAT
	SourceMCPOAuth
	SourceOAuthRefresh
)

// Observation pairs an event with bounded request-local correlation data.
type Observation struct {
	Event     model.CredentialUsageEvent
	RequestID string
	Source    Source
}

// Key identifies a credential independently of individual observations.
type Key struct {
	Kind              model.UsageSubjectKind
	UserID, SubjectID string
}

func (o Observation) Key() Key { return Key{o.Event.Kind, o.Event.UserID, o.Event.SubjectID} }

var ErrInvalidObservation = errors.New("invalid credential usage observation")
var ErrInvalidFault = errors.New("invalid credential usage fault")
var ErrUnknownBatch = errors.New("unknown credential usage batch")

func validID(s string) bool {
	id, err := model.CanonicalID(s)
	return err == nil && id == s && s != "00000000-0000-0000-0000-000000000000"
}
func validKey(k Key) bool {
	return (k.Kind == model.UsageSubjectPAT || k.Kind == model.UsageSubjectOAuthGrant) && validID(k.UserID) && validID(k.SubjectID)
}
func validRequestID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || i > 0 && (c == '.' || c == '_' || c == '-') {
			continue
		}
		return false
	}
	return true
}
func validObservation(o Observation) bool {
	t := o.Event.At
	return validKey(o.Key()) && !t.IsZero() && t.Location() == time.UTC && t.Nanosecond()%1000 == 0 && validRequestID(o.RequestID) && o.Source >= SourceHTTPPAT && o.Source <= SourceOAuthRefresh
}

func cloneObservation(o Observation) Observation {
	if o.Event.Kind == model.UsageSubjectPAT {
		o.Event.Kind = model.UsageSubjectPAT
	} else {
		o.Event.Kind = model.UsageSubjectOAuthGrant
	}
	o.Event.UserID = strings.Clone(o.Event.UserID)
	o.Event.SubjectID = strings.Clone(o.Event.SubjectID)
	o.RequestID = strings.Clone(o.RequestID)
	return o
}

func cloneFault(f Fault) Fault {
	f.Observation = cloneObservation(f.Observation)
	f.SQLState = strings.Clone(f.SQLState)
	f.OccurredAt = f.OccurredAt.UTC()
	return f
}

// Phase and Code restrict diagnostic labels to a fixed vocabulary.
type Phase uint8

const (
	PhaseSubmit Phase = iota + 1
	PhaseFlush
	PhaseRotation
	PhaseShutdown
	phaseEnd
)

type Code uint8

const (
	CodeQueueFull Code = iota + 1
	CodeWriteTimeout
	CodeWriteFailed
	CodeWriteOutcomeUnknown
	CodeRotationOutcomeUnknown
	CodeLagExceeded
	CodeShutdownIncomplete
	codeEnd
)

// Cause is a safe error category, never an error message or SQL text.
type Cause uint8

const (
	CauseNone Cause = iota
	CauseTimeout
	CauseCancelled
	CauseDatabase
	CauseUnknown
	CauseCapacity
	CauseStopped
	causeEnd
)

// Fault contains only fixed labels and safe event correlation. SQLState, when
// present, is a five-character upper-case alphanumeric PostgreSQL code.
type Fault struct {
	Phase       Phase
	Code        Code
	Cause       Cause
	Observation Observation
	OccurredAt  time.Time
	PendingAge  time.Duration
	Depth       int
	SQLState    string
}

func validFault(f Fault) bool {
	if f.Phase < PhaseSubmit || f.Phase >= phaseEnd || f.Code < CodeQueueFull || f.Code >= codeEnd || f.Cause >= causeEnd || !validObservation(f.Observation) || f.OccurredAt.IsZero() || f.PendingAge < 0 || f.Depth < 0 || f.Depth > ResidentLimit {
		return false
	}
	if f.SQLState != "" {
		if len(f.SQLState) != 5 {
			return false
		}
		for _, c := range f.SQLState {
			if !(c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
				return false
			}
		}
	}
	return true
}

// FaultSummary has bounded counts for every phase and code. First and Latest
// preserve their own event and request association. Revision changes on each
// occurrence, so acknowledgement cannot discard a newer occurrence.
type FaultSummary struct {
	Revision uint64
	Counts   [phaseEnd][codeEnd]uint64
	First    Fault
	Latest   Fault
}

func (s *FaultSummary) add(f Fault) {
	if s.Revision == 0 {
		s.First = f
	}
	s.Latest = f
	if s.Counts[f.Phase][f.Code] != ^uint64(0) {
		s.Counts[f.Phase][f.Code]++
	}
	s.Revision++
}

func (p Phase) String() string {
	switch p {
	case PhaseSubmit:
		return "submit"
	case PhaseFlush:
		return "flush"
	case PhaseRotation:
		return "rotation"
	case PhaseShutdown:
		return "shutdown"
	}
	return ""
}
func (c Code) String() string {
	switch c {
	case CodeQueueFull:
		return "queue_full"
	case CodeWriteTimeout:
		return "write_timeout"
	case CodeWriteFailed:
		return "write_failed"
	case CodeWriteOutcomeUnknown:
		return "write_outcome_unknown"
	case CodeRotationOutcomeUnknown:
		return "rotation_outcome_unknown"
	case CodeLagExceeded:
		return "lag_exceeded"
	case CodeShutdownIncomplete:
		return "shutdown_incomplete"
	}
	return ""
}
func (c Cause) String() string {
	switch c {
	case CauseNone:
		return "none"
	case CauseTimeout:
		return "timeout"
	case CauseCancelled:
		return "cancelled"
	case CauseDatabase:
		return "database"
	case CauseUnknown:
		return "unknown"
	case CauseCapacity:
		return "capacity"
	case CauseStopped:
		return "stopped"
	}
	return ""
}
func (s Source) String() string {
	switch s {
	case SourceHTTPPAT:
		return "http_pat"
	case SourceMCPPAT:
		return "mcp_pat"
	case SourceMCPOAuth:
		return "mcp_oauth"
	case SourceOAuthRefresh:
		return "oauth_refresh"
	}
	return ""
}
