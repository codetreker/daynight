package model

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

type DeviceAuthorization struct {
	// ApprovedScopes is nil before approval; approved decisions hold explicit IDs.
	ApprovedScopes      []scopepolicy.ScopeID
	ID                  string
	DeviceCodeHash      []byte
	UserCode            string
	Status              string
	UserID              *string
	CreatedAt           time.Time
	ExpiresAt           time.Time
	NextPollAt          time.Time
	PollIntervalSeconds int
}

type DeviceRateBucket struct {
	Hash  []byte
	Limit int
}
