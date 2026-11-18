package worker

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func NormalizeAlias(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	if !utf8.ValidString(*value) {
		return nil, invalidInput("Worker alias must be valid Unicode.")
	}
	// Reject controls before trimming so whitespace controls cannot be hidden.
	for _, r := range *value {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) ||
			r == '\u061c' || r == '\u200e' || r == '\u200f' ||
			(r >= '\u202a' && r <= '\u202e') || (r >= '\u2066' && r <= '\u2069') || r == '\ufeff' {
			return nil, invalidInput("Worker alias contains forbidden characters.")
		}
	}
	normalized := strings.TrimFunc(*value, unicode.IsSpace)
	if normalized == "" || utf8.RuneCountInString(normalized) > 80 {
		return nil, invalidInput("Worker alias must contain between 1 and 80 Unicode scalar values.")
	}
	return &normalized, nil
}

func AliasVersion(value string) (int64, error) {
	version, err := strconv.ParseInt(value, 10, 64)
	if err != nil || version < 1 || strconv.FormatInt(version, 10) != value {
		return 0, invalidInput("Worker alias expectedVersion must be a positive decimal int64 string.")
	}
	return version, nil
}

func ReadAlias(ctx context.Context, dao store.WorkerAliasReader, principal model.Principal, workerID string) (model.WorkerAlias, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.WorkerAlias{}, err
	}
	id, err := model.CanonicalID(workerID)
	if err != nil {
		return model.WorkerAlias{}, err
	}
	value, err := dao.WorkerAlias(ctx, principal.UserID, id)
	if errors.Is(err, model.ErrNotFound) {
		return model.WorkerAlias{}, &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
	}
	return value, err
}

func PutAlias(ctx context.Context, dao store.WorkerAliasWriter, principal model.Principal, workerID string, expected int64, value *string) (model.WorkerAlias, error) {
	normalized, err := NormalizeAlias(value)
	if err != nil {
		return model.WorkerAlias{}, err
	}
	current, err := ReadAlias(ctx, dao, principal, workerID)
	if err != nil {
		return model.WorkerAlias{}, err
	}
	if expected != current.Version {
		return model.WorkerAlias{}, &model.Fault{Code: "version_conflict", Message: "Worker alias has changed."}
	}
	next := model.WorkerAlias{Value: normalized, Version: current.Version}
	if (current.Value == nil) != (normalized == nil) || (current.Value != nil && normalized != nil && *current.Value != *normalized) {
		if next.Version == math.MaxInt64 {
			return model.WorkerAlias{}, &model.Fault{Code: "version_conflict", Message: "Worker alias version is exhausted."}
		}
		next.Version++
	}
	id, _ := model.CanonicalID(workerID)
	if err := dao.SetWorkerAlias(ctx, principal.UserID, id, expected, next); err != nil {
		return model.WorkerAlias{}, err
	}
	return next, nil
}
