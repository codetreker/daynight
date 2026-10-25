package core

import "time"

type DeviceAuthorization struct {
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
