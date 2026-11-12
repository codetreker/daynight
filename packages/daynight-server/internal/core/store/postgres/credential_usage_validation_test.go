package postgres

import (
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestCredentialUsageBatchValidation(t *testing.T) {
	valid := model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: "11111111-1111-1111-1111-111111111111", SubjectID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", At: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	cases := []struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{
		{"valid", []model.CredentialUsageEvent{valid}, true},
		{"empty", nil, false},
		{"too large", make([]model.CredentialUsageEvent, 129), false},
		{"duplicate", []model.CredentialUsageEvent{valid, valid}, false},
	}
	bad := valid
	bad.Kind = "other"
	cases = append(cases, struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{"kind", []model.CredentialUsageEvent{bad}, false})
	bad = valid
	bad.SubjectID = strings.ToUpper(valid.SubjectID)
	cases = append(cases, struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{"noncanonical", []model.CredentialUsageEvent{bad}, false})
	bad = valid
	bad.UserID = "00000000-0000-0000-0000-000000000000"
	cases = append(cases, struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{"nil id", []model.CredentialUsageEvent{bad}, false})
	bad = valid
	bad.At = time.Time{}
	cases = append(cases, struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{"zero time", []model.CredentialUsageEvent{bad}, false})
	bad = valid
	bad.At = valid.At.Add(time.Nanosecond)
	cases = append(cases, struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{"precision", []model.CredentialUsageEvent{bad}, false})
	bad = valid
	bad.At = valid.At.In(time.FixedZone("other", 0))
	cases = append(cases, struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{"zone", []model.CredentialUsageEvent{bad}, false})
	bad = valid
	bad.Kind = model.UsageSubjectOAuthGrant
	cases = append(cases, struct {
		name   string
		events []model.CredentialUsageEvent
		valid  bool
	}{"unordered", []model.CredentialUsageEvent{valid, bad}, false})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateUsageBatch(tc.events); (err == nil) != tc.valid {
				t.Fatalf("validation: %v", err)
			}
		})
	}
}
