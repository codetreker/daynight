package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type UserCandidateQuery struct {
	Query   string
	AfterID *string
	Limit   int
}

type UserCandidatePage struct {
	Items   []model.UserCandidate
	HasMore bool
}

type UserCandidateReader interface {
	MemberCandidates(context.Context, UserCandidateQuery) (UserCandidatePage, error)
}
