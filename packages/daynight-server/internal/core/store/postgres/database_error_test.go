package postgres

import (
	"errors"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestDatabaseErrorFactsFindsJoinedFailureAndPreservesCause(t *testing.T) {
	cause := errors.New("driver detail")
	err := errors.Join(&Error{Phase: "read", Cause: errors.New("validation")}, &Error{Phase: "write", DatabaseFailure: true, SQLState: "23505", Cause: cause})
	failed, state := DatabaseErrorFacts(err)
	if !failed || state != "23505" || !errors.Is(err, cause) {
		t.Fatalf("database facts = (%v, %q), cause retained = %v", failed, state, errors.Is(err, cause))
	}
	if failed, state = DatabaseErrorFacts(&Error{Phase: "decode", Cause: errors.New("validation")}); failed || state != "" {
		t.Fatalf("validation classified as database failure: (%v, %q)", failed, state)
	}
}
